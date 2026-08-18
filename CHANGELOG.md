# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-18

### Added

- `/btw <question>` command: ask a side question in a floating top-center
  overlay while the main agent keeps running; answers stream into the overlay
  and never enter the main conversation or its context window.
- Read-only side agent with tool whitelist `read` / `grep` / `find` / `ls` —
  it can inspect the repo but cannot modify anything.
- Side thread memory: the side agent is seeded with the main session's real
  messages and remembers earlier side questions (up to 20 exchanges).
- Follow-up questions typed directly into the overlay continue the same side
  thread; `/btw` with no arguments reopens the overlay on the latest history.
- `Alt+/` (fallback `Ctrl+Alt+W`) toggles focus between the overlay and the
  main editor while the overlay stays visible.
- Overlay keys: `Enter` submit, `Esc` abort/close, `c` copy the raw markdown
  answer to clipboard, `←`/`→` page through this session's side Q&A history,
  `↑`/`↓` scroll long answers.
- Markdown-rendered answers via pi-tui `Markdown`, with a streaming indicator
  that shows the currently running tool.
- Model and thinking level inherit the main session and re-sync before every
  ask.
- CI workflow: typecheck on push and pull request.
