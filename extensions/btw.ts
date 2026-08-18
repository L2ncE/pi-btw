import { contentText } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	copyToClipboard,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	getMarkdownTheme,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ResourceLoader,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	Markdown,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

/**
 * pi-btw-cc — Claude Code-style /btw side questions.
 *
 * `/btw <question>` asks a side question in a floating top-center overlay
 * while the main agent keeps running. The side agent is a real in-memory
 * pi sub-session seeded with the main session's messages, restricted to
 * read-only tools (read/grep/find/ls). Nothing is ever written back to the
 * main conversation; the side thread lives only in this extension instance.
 */

const BTW_SYSTEM_PROMPT = [
	"You are a temporary, read-only side agent answering one quick question for the user.",
	"The main agent continues its work uninterrupted; you share its conversation as background context only.",
	"You have read-only tools (read, grep, find, ls) so you may inspect the repository to answer accurately.",
	"Never claim to have modified anything, and never promise to take any action later.",
	"Answer directly and concisely.",
].join(" ");

const MAX_HISTORY_EXCHANGES = 20;

interface BtwExchange {
	question: string;
	answer: string;
	aborted?: boolean;
	error?: string;
}

interface BtwActive {
	question: string;
	answer: string;
	toolName: string | null;
}

/** The single source for "which exchange is on screen": live answer, or a history entry. */
interface BtwSelection {
	question: string;
	answer: string;
	label: string;
	error?: string;
}

interface OverlayRuntime {
	handle?: OverlayHandleLike;
	refresh?: () => void;
	setStatus?: (status: string) => void;
	finish?: () => void;
	closed?: boolean;
	close: () => void;
}

interface OverlayHandleLike {
	focus(): void;
	unfocus(): void;
	hide(): void;
}

/**
 * Strip the dynamic footer (date/cwd) pi appends to the live system prompt so
 * the seeded sub-session gets a stable base prompt. The footer text lives in
 * pi's runtime prompt template, not the SDK; if pi changes it, the worst case
 * is a stale date in the side agent's prompt.
 */
function stableSystemPrompt(systemPrompt: string): string {
	return systemPrompt
		.replace(/\nCurrent date and time:[^\n]*(\nCurrent working directory:[^\n]*)?$/u, "")
		.replace(/\nCurrent working directory:[^\n]*$/u, "")
		.trim();
}

function createBtwResourceLoader(ctx: ExtensionCommandContext): ResourceLoader {
	return new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		// The main session's composed prompt already includes context files.
		systemPrompt: stableSystemPrompt(ctx.getSystemPrompt() ?? ""),
		appendSystemPrompt: [BTW_SYSTEM_PROMPT],
	});
}

export default function btw(pi: ExtensionAPI) {
	const exchanges: BtwExchange[] = [];
	let active: BtwActive | null = null;
	// Points at the currently displayed exchange; after every ask it is the newest one.
	let viewIndex = 0;
	let overlayRuntime: OverlayRuntime | null = null;
	let subSession: AgentSession | null = null;
	let subscribed = false;

	function setStatus(status: string): void {
		if (overlayRuntime?.setStatus) overlayRuntime.setStatus(status);
	}

	function refreshOverlay(): void {
		overlayRuntime?.refresh?.();
	}

	function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
		try {
			ctx.ui.notify(message, level);
		} catch {
			// Context may be replaced while an async ask is in flight.
		}
	}

	function currentSelection(): BtwSelection | null {
		if (active) return { question: active.question, answer: active.answer, label: "answering…" };
		const exchange = exchanges[viewIndex];
		if (!exchange) return null;
		const suffix = exchange.aborted ? " (aborted)" : exchange.error ? " (error)" : "";
		return {
			question: exchange.question,
			answer: exchange.answer,
			error: exchange.error,
			label: `${viewIndex + 1}/${exchanges.length}${suffix}`,
		};
	}

	function capHistory(): void {
		while (exchanges.length > MAX_HISTORY_EXCHANGES) {
			exchanges.shift();
			viewIndex = Math.max(0, viewIndex - 1);
		}
	}

	async function ensureBtwSession(ctx: ExtensionCommandContext): Promise<AgentSession | null> {
		if (subSession) return subSession;
		if (!ctx.model) {
			notify(ctx, "No active model for /btw", "error");
			return null;
		}
		const resourceLoader = createBtwResourceLoader(ctx);
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			model: ctx.model,
			thinkingLevel: pi.getThinkingLevel(),
			tools: ["read", "grep", "find", "ls"],
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		// The SDK has no initialMessages option; direct state seeding is the supported-by-necessity route.
		const seed = buildSessionContext(
			ctx.sessionManager.getEntries(),
			ctx.sessionManager.getLeafId(),
		).messages;
		if (seed.length > 0) {
			session.agent.state.messages = seed;
		}
		subSession = session;
		return session;
	}

	function handleSessionEvent(event: AgentSessionEvent): void {
		if (!active) return;
		if (event.type === "message_update" && event.message.role === "assistant") {
			active.answer = contentText(event.message.content).trim();
			refreshOverlay();
		} else if (event.type === "tool_execution_start") {
			active.toolName = event.toolName;
			refreshOverlay();
		} else if (event.type === "tool_execution_end") {
			active.toolName = null;
			refreshOverlay();
		}
	}

	function finishExchange(exchange: BtwExchange, status: string): void {
		exchanges.push(exchange);
		active = null;
		viewIndex = exchanges.length - 1;
		capHistory();
		setStatus(status);
		refreshOverlay();
	}

	async function ask(ctx: ExtensionCommandContext, question: string): Promise<void> {
		if (active) {
			setStatus("Still answering — press Esc to abort first.");
			return;
		}
		const session = await ensureBtwSession(ctx);
		if (!session) return;

		if (!subscribed) {
			session.subscribe(handleSessionEvent);
			subscribed = true;
		}

		// Follow the main session's current model and thinking level.
		try {
			if (ctx.model) await session.setModel(ctx.model);
			session.setThinkingLevel(pi.getThinkingLevel());
		} catch {
			// Keep whatever the sub-session already uses.
		}

		active = { question, answer: "", toolName: null };
		refreshOverlay();
		setStatus("streaming…");

		try {
			await session.prompt(question, { source: "extension" });
		} catch (error) {
			finishExchange(
				{ question, answer: active.answer, error: error instanceof Error ? error.message : String(error) },
				"error",
			);
			return;
		}

		const response = [...session.messages].reverse().find((message) => message.role === "assistant");
		if (response?.stopReason === "aborted") {
			finishExchange({ question, answer: contentText(response.content).trim(), aborted: true }, "aborted");
		} else if (response && response.stopReason !== "error") {
			finishExchange({ question, answer: contentText(response.content).trim() || "(no answer)" }, "");
		} else {
			finishExchange(
				{
					question,
					answer: active.answer,
					error: response?.errorMessage ?? "The side agent returned an error.",
				},
				"error",
			);
		}
	}

	async function abortActive(): Promise<void> {
		if (!active || !subSession) return;
		try {
			await subSession.abort();
		} catch {
			// Abort races are fine; the prompt() call resolves with stopReason "aborted".
		}
	}

	function closeOverlay(): void {
		overlayRuntime?.close();
	}

	async function copyCurrentAnswer(ctx: ExtensionCommandContext): Promise<void> {
		const answer = currentSelection()?.answer;
		if (!answer) {
			setStatus("Nothing to copy yet.");
			return;
		}
		try {
			await copyToClipboard(answer);
			setStatus("Copied markdown answer to clipboard.");
		} catch (error) {
			notify(ctx, `Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	function ensureOverlay(ctx: ExtensionCommandContext): void {
		if (overlayRuntime?.handle) {
			overlayRuntime.handle.focus();
			refreshOverlay();
			return;
		}
		const runtime: OverlayRuntime = {
			close: () => {
				if (runtime.closed) return;
				runtime.closed = true;
				runtime.handle?.hide();
				if (overlayRuntime === runtime) overlayRuntime = null;
				runtime.finish?.();
			},
		};
		overlayRuntime = runtime;

		void ctx.ui
			.custom<void>(
				(tui, theme, _keybindings, done) => {
					runtime.finish = () => done();

					const overlay = new BtwOverlayComponent(tui, theme, {
						readExchanges: () => exchanges,
						readActive: () => active,
						readViewIndex: () => viewIndex,
						readCurrent: () => currentSelection(),
						setViewIndex: (index) => {
							viewIndex = index;
						},
						onSubmit: (value) => {
							void ask(ctx, value.trim());
						},
						onDismiss: () => {
							if (active) {
								void abortActive();
								return;
							}
							closeOverlay();
						},
						onCopy: () => {
							void copyCurrentAnswer(ctx);
						},
						onUnfocus: () => {
							overlayRuntime?.handle?.unfocus();
							refreshOverlay();
						},
					});

					runtime.refresh = () => overlay.refresh();
					runtime.setStatus = (status: string) => {
						overlay.setStatus(status);
					};

					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "78%",
						minWidth: 64,
						maxHeight: "78%",
						anchor: "top-center",
						margin: { top: 1, left: 2, right: 2 },
						nonCapturing: true,
					},
					onHandle: (handle) => {
						runtime.handle = handle;
						handle.focus();
						if (runtime.closed) runtime.close();
					},
				},
			)
			.catch((error: unknown) => {
				if (overlayRuntime === runtime) overlayRuntime = null;
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
			});
	}

	// Toggle focus between the overlay and the main editor while the overlay stays visible.
	for (const shortcut of ["alt+/", "ctrl+alt+w"]) {
		pi.registerShortcut(shortcut as never, {
			description: "Focus the /btw overlay",
			handler: () => {
				if (!overlayRuntime?.handle) return;
				overlayRuntime.handle.focus();
				refreshOverlay();
			},
		});
	}

	pi.registerCommand("btw", {
		description: "Ask a quick side question in an overlay without interrupting the main conversation",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw requires interactive TUI mode", "error");
				return;
			}
			const question = args.trim();
			if (!question) {
				// No question: just open the overlay on the latest history entry.
				ensureOverlay(ctx);
				refreshOverlay();
				return;
			}
			ensureOverlay(ctx);
			await ask(ctx, question);
		},
	});
}

const BTW_FOCUS_KEYS = [Key.alt(Key.slash), Key.ctrlAlt("w")] as const;

function matchesBtwFocusKey(data: string): boolean {
	return BTW_FOCUS_KEYS.some((key) => matchesKey(data, key));
}

interface BtwOverlayCallbacks {
	readExchanges: () => BtwExchange[];
	readActive: () => BtwActive | null;
	readViewIndex: () => number;
	readCurrent: () => BtwSelection | null;
	setViewIndex: (index: number) => void;
	onSubmit: (value: string) => void;
	onDismiss: () => void;
	onCopy: () => void;
	onUnfocus: () => void;
}

const CHROME_LINES = 7; // top border, title, rule, status, input, hints, bottom border
const MIN_CONTENT_LINES = 4;

class BtwOverlayComponent implements Component, Focusable {
	private readonly input = new Input();
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly callbacks: BtwOverlayCallbacks;
	private status = "";
	private scrollOffset = 0;
	private followBottom = true;
	focused = false;

	constructor(tui: TUI, theme: Theme, callbacks: BtwOverlayCallbacks) {
		this.tui = tui;
		this.theme = theme;
		this.callbacks = callbacks;
		this.input.onSubmit = (value) => {
			// Keep the draft when the ask is rejected (still answering); the parent shows a hint.
			if (!this.callbacks.readActive()) this.input.setValue("");
			this.followBottom = true;
			this.callbacks.onSubmit(value);
		};
	}

	setStatus(status: string): void {
		this.status = status;
		this.tui.requestRender();
	}

	refresh(): void {
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesBtwFocusKey(data)) {
			this.callbacks.onUnfocus();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.callbacks.onDismiss();
			return;
		}
		const inputEmpty = this.input.getValue().length === 0;
		if (inputEmpty) {
			if (matchesKey(data, Key.left)) {
				const index = this.callbacks.readViewIndex();
				if (!this.callbacks.readActive() && index > 0) {
					this.callbacks.setViewIndex(index - 1);
					this.followBottom = false;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, Key.right)) {
				const exchanges = this.callbacks.readExchanges();
				const index = this.callbacks.readViewIndex();
				if (!this.callbacks.readActive() && index < exchanges.length - 1) {
					this.callbacks.setViewIndex(index + 1);
					this.tui.requestRender();
				}
				return;
			}
			if (data === "c" || data === "C") {
				this.callbacks.onCopy();
				return;
			}
			if (matchesKey(data, Key.up)) {
				this.followBottom = false;
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.scrollOffset += 1;
				this.tui.requestRender();
				return;
			}
		}
		this.input.handleInput(data);
	}

	/** Clamp the scroll state against the current content; returns the visible offset. */
	private clampScroll(contentHeight: number, maxRows: number): number {
		if (contentHeight <= maxRows) {
			this.scrollOffset = 0;
			return 0;
		}
		const maxOffset = contentHeight - maxRows;
		if (this.followBottom) this.scrollOffset = maxOffset;
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		if (this.scrollOffset >= maxOffset) this.followBottom = true;
		return this.scrollOffset;
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
	}

	private ruleLine(innerWidth: number): string {
		return this.theme.fg("border", `├${"─".repeat(Math.max(1, innerWidth))}┤`);
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	private inputFrameLine(innerWidth: number): string {
		const targetWidth = Math.max(1, innerWidth);
		const previousFocused = this.input.focused;
		// Render the embedded input unfocused: the emitted cursor marker skews the row.
		this.input.focused = false;
		try {
			const rendered = this.input.render(targetWidth)[0] ?? "";
			const line = truncateToWidth(rendered, targetWidth, "");
			const padding = Math.max(0, targetWidth - visibleWidth(line));
			return `${this.theme.fg("border", "│")}${line}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
		} finally {
			this.input.focused = previousFocused;
		}
	}

	render(width: number): string[] {
		const dim = (color: ThemeColor, text: string) => this.theme.fg(color, text);
		const dialogWidth = Math.max(40, width);
		const innerWidth = Math.max(20, dialogWidth - 2);
		const exchanges = this.callbacks.readExchanges();
		const active = this.callbacks.readActive();
		const view = this.callbacks.readCurrent();

		const contentLines: string[] = [];

		// Dimmed one-liners for the other exchanges (Claude Code-style history list).
		for (let i = 0; i < exchanges.length; i++) {
			if (i === this.callbacks.readViewIndex() && !active) continue;
			const oneLiner = truncateToWidth(exchanges[i].question, innerWidth - 4, "…");
			contentLines.push(dim("dim", `  ${i + 1}. ${oneLiner}`));
		}

		if (view) {
			if (contentLines.length > 0) contentLines.push("");
			contentLines.push(dim("accent", `You: ${truncateToWidth(view.question, innerWidth - 5, "…")}`));
			if (view.error) {
				contentLines.push(dim("warning", `⚠ ${view.error}`));
			}
			const answerLines = view.answer
				// Rebuilt per render so markdown styling always follows the live theme.
				? new Markdown(view.answer, 0, 0, getMarkdownTheme()).render(Math.max(1, innerWidth - 2))
				: [dim("dim", active ? "…" : "(empty)")];
			contentLines.push(...answerLines);
		} else if (exchanges.length === 0) {
			contentLines.push(dim("dim", "No side questions yet."));
		}

		const maxRows = Math.max(
			MIN_CONTENT_LINES,
			Math.floor((process.stdout.rows ?? 30) * 0.78) - CHROME_LINES,
		);
		const scrollOffset = this.clampScroll(contentLines.length, maxRows);
		const hiddenAbove = contentLines.length > maxRows ? scrollOffset : 0;
		const visible = contentLines.slice(scrollOffset, scrollOffset + maxRows);

		const statusText =
			this.status ||
			(active ? `streaming…${active.toolName ? ` · ${active.toolName}` : ""}` : view ? view.label : "ready");
		const viewLabel = active ? "" : ` · ${exchanges.length} in memory`;
		const scrollHint = hiddenAbove ? ` · ↑${hiddenAbove} above · ↑↓ scroll` : "";

		const lines: string[] = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(dim("accent", `btw · side question${viewLabel}`), innerWidth),
			this.ruleLine(innerWidth),
			...visible.map((line) => this.frameLine(line, innerWidth)),
			this.ruleLine(innerWidth),
			this.frameLine(dim("warning", statusText), innerWidth),
			this.inputFrameLine(innerWidth),
			this.frameLine(
				dim(
					"dim",
					`enter ask · c copy · ←→ history · alt+/ main editor${scrollHint} · esc ${active ? "abort" : "close"}`,
				),
				innerWidth,
			),
			this.borderLine(innerWidth, "bottom"),
		];
		return lines.map((line) =>
			visibleWidth(line) > dialogWidth ? truncateToWidth(line, dialogWidth, "") : line,
		);
	}

	invalidate(): void {
		this.tui.requestRender();
	}
}
