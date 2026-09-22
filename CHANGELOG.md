# Change Log

All notable changes to the "gbs-local-dev" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.11] - 2026-09-22

### Changed
- New identity: an abstract mark of three strokes spiralling outward, in GramPro's orange-to-red gradient. It replaces the generic sparkle and the built-in `$(robot)` codicon, and is used for the Marketplace icon, the activity bar, the chat panel and the product page, so the extension is recognisable beside other agents and clearly belongs to GramPro.
- The product page (`docs/`) now uses the GramPro palette throughout. Interactive colours are deepened so button text and links meet WCAG AA contrast.

## [0.0.10] - 2026-09-22

### Added
- **Agent skills.** Folders with a `SKILL.md` that teach the agent project- or team-specific knowledge (a component library, a service's conventions, a project's domain rules). Only each skill's name and description are always in the prompt (~45 tokens each); the instructions load when the agent decides they apply, and bundled reference files load only when opened.
  - Skills are read from `.gbs/skills/` and `.claude/skills/` in the project, from dependencies that declare `"gbsSkills"` in their package.json, and from a personal folder shared across projects.
  - `autoAttach` globs mark a skill relevant to the file you have open, which helps smaller local models pick the right one.
  - New commands: **New Skill**, **Open Skills Folder**, **Reload Skills**; `/skills` in the chat; a skills chip under the input.
  - Skills from a repository or dependency are used only after a one-time confirmation per workspace, and are labelled as repository-provided when given to the model.
  - With no skills present, prompts and tool schemas are unchanged from before this release.

## [0.0.9] - 2026-09-17

### Security
- A repository's `.vscode/settings.json` can no longer change where code and API keys are sent, the shell, the model, or the approval mode. These settings are read from user settings only. The extension is also disabled in untrusted (Restricted Mode) workspaces.
- The saved API key is bound to the endpoint it was saved for; sending it anywhere else needs confirmation. Requests never follow redirects.
- Asks once before sending code to a remote or cloud model (e.g. `:cloud` Ollama models), and shows a "cloud" badge on the model chip.
- Commands run without approval only when they exactly match a short read-only list (`git status`, `git log --oneline`, `dir`, …). `git diff`/`git show` and any extra arguments now need approval.
- On Windows, commands no longer run programs from the workspace folder in place of the real ones (e.g. a planted `git.bat`). Git commands can no longer trigger a repository-configured `core.fsmonitor` program.
- "Always allow" never widens interpreters, downloaders, or destructive commands (`python`, `node`, `curl`, `rm`, …) beyond the exact command, and never covers a bare `npm run`.
- Edits to files that run code or control tooling always need approval, even in Auto-edit mode: `.vscode`, `.git`, `.github`, `package.json`, scripts, linter/test/build configs (ESLint, Prettier, Jest, Vite, …), `node_modules`, and similar.
- Reading likely credential files (`.env`, keys, `.npmrc`, …) needs approval, and search skips them.
- Symbolic links and junctions can no longer be used to read or write outside the workspace.
- Commands no longer inherit credentials from the editor's environment (tokens, API keys, passwords).
- Tool-call syntax appearing inside the model's prose or code blocks (for example quoted from a malicious file) is never executed.
- The system prompt treats file contents and tool output as untrusted data, and repository instruction files can no longer override safety rules.
- Approval cards show the full command and warn about chained commands, network access, redirection, and invisible or text-direction characters, which are highlighted. Edit approvals preview the new content.
- Subagents are capped at 4 running at once and 12 per request.
- Hardening: size and stall limits on model responses, a 10 MB limit for reading files, protection against catastrophic regexes in the fallback search, a cryptographically random webview nonce, and link destinations shown on hover.
- New command **GBS Agent: Clear Chat History**.

## [0.0.8] - 2026-09-17

### Fixed
- The task checklist could stay unchecked after the work was done: the agent is now reminded once to update it before finishing, a leftover list is shown as "not finished", and a completed list is cleared when the next request starts.

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