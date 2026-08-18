<div align="center">

<img src="https://cdn.jsdelivr.net/gh/L2ncE/pi-btw@main/assets/logo.png" alt="pi-btw" width="280"/>

**`/btw` for [pi](https://pi.dev) — ask while it works.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/L2ncE/pi-btw/actions/workflows/ci.yml/badge.svg)](https://github.com/L2ncE/pi-btw/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)

[中文说明](README_zh.md)

</div>

## What Is This

The main agent is elbow-deep in a refactor, and a random question pops into
your head — *what was that config file called?* Until now you either
interrupted the run or opened another terminal.

`/btw` answers it in a floating overlay while the main agent keeps running:

```
/btw what was that config file called?
/btw what does this error actually mean?
```

Inspired by Claude Code's `/btw`, rebuilt natively for pi:

- the answer streams into a **top-center overlay**; the main view keeps moving
- **never** enters the main conversation or its context window
- the side agent sees the main session's real messages, and remembers your
  earlier side questions — up to 20 exchanges
- **read-only tools** (`read` / `grep` / `find` / `ls`): it can inspect the
  repo itself, but cannot touch anything
- follow-ups typed straight into the overlay continue the same side thread

![pi-btw in action](https://cdn.jsdelivr.net/gh/L2ncE/pi-btw@main/assets/screenshot.png)

## Install

```bash
pi install npm:@lanlance/pi-btw
```

or via git:

```bash
pi install git:https://github.com/L2ncE/pi-btw
```

or try without installing:

```bash
pi -e /path/to/pi-btw
```

## Usage

Type `/btw <question>` at any time — including while the main agent is
mid-task (pi runs extension commands immediately instead of queueing them).

Overlay keys:

| Key | Action |
|---|---|
| `Enter` | submit the follow-up in the input |
| `Esc` | abort while answering; close when idle |
| `c` | copy the current answer (raw markdown) to the clipboard |
| `←` / `→` | page through this session's side Q&A history |
| `↑` / `↓` | scroll a long answer |
| `Alt+/` | toggle focus between the overlay and the main editor (overlay stays visible; `Ctrl+Alt+W` as fallback) |

Earlier questions appear as a dimmed list above the current answer. The side
thread lives in memory only — `/new`, restarts and reloads clear it, and none
of it ever reaches the main conversation.

## Design

- one lazily-created in-memory `AgentSession` sub-session per pi session
  (`SessionManager.inMemory()`, nothing on disk), seeded with the main
  session's messages via `buildSessionContext`
- tool whitelist `["read", "grep", "find", "ls"]` — no bash, no edit, no write
- model and thinking level inherit the main session and re-sync before every ask
- the system prompt tells the side agent exactly what it is: temporary,
  read-only, never promises actions

## License

Apache-2.0
