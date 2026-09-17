# Change Log

All notable changes to the "gbs-local-dev" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.7] - 2026-09-17

### Changed
- Rebuilt the agent around native tool calling (Ollama and OpenAI-compatible), with automatic fallback to a text tool protocol for models without tool support.
- New tool set: `read_file` (ranged), `edit_file` (exact replace), `write_file`, `grep` (ripgrep), `glob`, `list_dir`, `run_command` (timeout, live output, kill on stop), `todo_write`, and `task` subagents (parallel read-only explore, or general).
- Conversation history is kept across messages and compacted only when needed; the system prompt stays stable so prompt caches are reused.
- Edits are verified with editor diagnostics instead of running a build after every step.
- Redesigned chat UI: streaming markdown, tool and subagent cards, live command output, task checklist, approval cards, changed-files summary with diffs, chat history, model menu, permission modes, and context usage meter.
- Chat history is stored in VS Code workspace state instead of `.vscode/bunker-session.json`.

### Fixed
- Ollama streaming dropped tokens and tool calls when a JSON line was split across network chunks.
- Tool results were cached by arguments, so re-running commands (e.g. tests) returned stale output.
- File paths were not restricted to the workspace.
- Commands had no timeout, output limit, approval, or cancellation.