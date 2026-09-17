# GBS Software Agent

An autonomous coding agent for VS Code that runs on local models (Ollama) or any OpenAI-compatible endpoint (Hugging Face router, vLLM, LM Studio, OpenRouter, …). It explores your codebase, edits files, runs commands, and shows every step in the chat panel.

## Quick start

1. Install [Ollama](https://ollama.com/download) and pull a model with tool-calling support, for example:
   ```
   ollama pull qwen3-coder:30b
   ollama pull qwen2.5-coder:7b   # optional: cheaper model for subagents
   ```
2. Build and install the extension (`npm install`, then `npx vsce package` and install the `.vsix`), or press <kbd>F5</kbd> to run it in an Extension Development Host.
3. Open the **GBS Agent** view in the activity bar. Pick the provider and model from the model menu below the input, and start chatting.

To use an OpenAI-compatible endpoint, choose **OpenAI-compatible** in the model menu, set `gbsAgent.openai.baseUrl`, and run **GBS Agent: Set API Key** (stored in VS Code secret storage).

## Using it

- <kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a newline, and <kbd>Esc</kbd> stops the agent. Messages sent while the agent is working are delivered at its next step.
- The open file and any selection are attached as context (toggle with the chip above the input).
- `/new` starts a new chat, and `/compact` summarizes the conversation to free context. Past chats are in the history menu (click the chat title).
- The permission chip cycles between **Auto-edit** (default: edits apply, commands need approval), **Ask first**, and **Full auto**.
- Each turn ends with a summary of changed files. Click a file to open it, or the diff icon to compare with the version before the turn.
- Add an `AGENTS.md` (or `CLAUDE.md`) at the workspace root to give the agent project-specific instructions.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `gbsAgent.provider` | `ollama` | `ollama` or `openai` (OpenAI-compatible) |
| `gbsAgent.model` | `deepseek-v4-flash:cloud` | Main agent model |
| `gbsAgent.subagentModel` | *(empty)* | Cheaper model for exploration subagents |
| `gbsAgent.permissionMode` | `acceptEdits` | `ask`, `acceptEdits`, or `auto` |
| `gbsAgent.contextWindow` | `32768` | Sent to Ollama as `num_ctx`; drives compaction |
| `gbsAgent.maxOutputTokens` | `8192` | Max tokens per response |
| `gbsAgent.maxSteps` | `60` | Model calls per request before pausing |
| `gbsAgent.commandTimeoutSeconds` | `120` | Default shell command timeout |
| `gbsAgent.shell` | *(empty)* | Shell for commands (default: cmd.exe on Windows) |
| `gbsAgent.ollama.baseUrl` / `gbsAgent.openai.baseUrl` | | Endpoints |

Logs are in the **GBS Agent** output channel (**GBS Agent: Show Logs**).

## Development

```
npm install
npm run watch     # esbuild + tsc in watch mode
npm test          # integration tests in a real VS Code instance
```

See [architecture.md](architecture.md) for how the agent works.
