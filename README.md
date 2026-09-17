# GBS SE Agent

An autonomous coding agent inside VS Code. Describe a task in the chat panel and the agent explores your codebase, edits files, runs commands, and shows every step as it works. It runs on **local models** (Ollama, LM Studio, llama.cpp, vLLM) or any **OpenAI-compatible** cloud endpoint (Hugging Face router, OpenRouter, …).

## Get started

### 1. Install the extension

Requires VS Code 1.120 or later.

- In VS Code, open the **Extensions** view (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd>), search for **GBS SE Agent**, and click **Install**.
- Or run: `code --install-extension gbs-internal-toolchain.gbs-software-agent`

### 2. Set up a model

Choose one of these:
- **Local model (recommended):** your code never leaves your machine. See [Running local models](#running-local-models).
- **Cloud model:** see [Using a cloud model](#using-a-cloud-model).

### 3. Open a project and start chatting

1. Open your project folder (**File → Open Folder…**) and trust it when VS Code asks. The agent stays disabled in Restricted Mode.
2. Click the **GBS Agent** robot icon in the activity bar.
3. Click the model chip under the chat input, and select your provider and model.
4. Type a task, for example *"Add input validation to the signup form and run the tests"*, and press <kbd>Enter</kbd>.

## Running local models

### Ollama (built-in default)

1. Install [Ollama](https://ollama.com/download). It runs in the background at `http://localhost:11434`. If it isn't running, start it with `ollama serve`.
2. Pull a model that supports **tool calling**, for example:
   ```
   ollama pull qwen3-coder:30b      # strong coding model, needs a capable GPU (~20 GB)
   ollama pull qwen2.5-coder:14b    # good balance for mid-range GPUs
   ollama pull qwen2.5-coder:7b     # runs on most laptops; also a good subagent model
   ```
3. In the chat panel's model menu:
   - **Provider:** Ollama.
   - **Model:** pick the model you pulled. The list is loaded from Ollama.
   - **Subagent model** (optional): a smaller model for codebase exploration, which saves time and memory.

The default model is `deepseek-v4-flash:cloud`. Models whose name ends in `:cloud` or `-cloud` run on Ollama's servers, not your machine. Select a local model to keep everything on your machine. The model chip shows a **cloud** badge whenever a remote model is selected.

**Memory:** the agent asks Ollama for a 32K-token context window (`gbsAgent.contextWindow`). If a model runs out of memory or is very slow, set it to `16384`. If you have plenty of VRAM, raise it for large tasks.

### LM Studio, llama.cpp, vLLM, and other OpenAI-compatible servers

Any local server with an OpenAI-compatible `/v1/chat/completions` endpoint works. No API key is needed for `localhost` servers.

1. Start the server with a tool-calling capable model:

   | Server | How to start | Base URL |
   |---|---|---|
   | [LM Studio](https://lmstudio.ai) | Load a model, then start the server in the **Developer** tab | `http://localhost:1234/v1` |
   | llama.cpp | `llama-server -m model.gguf --jinja -c 32768` (`--jinja` enables tool calling) | `http://localhost:8080/v1` |
   | vLLM | `vllm serve <model> --enable-auto-tool-choice --tool-call-parser <parser>` (e.g. `hermes` for Qwen) | `http://localhost:8000/v1` |

2. Open **Settings** (<kbd>Ctrl</kbd>+<kbd>,</kbd>), search for `gbsAgent.openai.baseUrl`, and enter the server's base URL in your **User** settings.
3. In the model menu, choose **OpenAI-compatible** and pick the model.
4. Set `gbsAgent.contextWindow` to the context length the server was started with, so the agent compacts the conversation before it overflows.

### Which models work

The agent relies on the model calling tools (reading files, editing, running commands):
- **Best:** models trained for tool use, such as Qwen2.5/Qwen3 Coder, Devstral, gpt-oss, and Llama 3.1+.
- **Other models:** if a model rejects tool definitions, the agent automatically switches to a text-based tool format. This works, but less reliably.
- **Size matters:** very small models (under ~7B) often struggle with multi-step tasks.

## Using a cloud model

1. In **Settings**, set `gbsAgent.openai.baseUrl` to your provider's endpoint. The default is the Hugging Face router, `https://router.huggingface.co/v1`.
2. Run **GBS Agent: Set API Key** from the Command Palette (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>). The key is kept in VS Code's secret storage and only sent to that endpoint.
3. In the model menu, choose **OpenAI-compatible** and enter the model ID (for example `Qwen/Qwen2.5-Coder-32B-Instruct`).

The first time the agent sends code to a remote endpoint or cloud model, it asks for confirmation. It asks once per destination.

## Using it

- <kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a newline, and <kbd>Esc</kbd> stops the agent. Messages sent while the agent is working are delivered at its next step.
- The open file and any selected code are attached as context. Toggle this with the chip above the input.
- `/new` starts a new chat, and `/compact` summarizes the conversation to free context. Past chats are in the history menu (click the chat title).
- The permission chip cycles between **Auto-edit** (default: ordinary edits apply, commands and sensitive files need approval), **Ask first**, and **Full auto**. See [Security](#security).
- Each turn ends with a summary of changed files. Click a file to open it, or the diff icon to compare it with the version before the turn.
- Add an `AGENTS.md` (or `CLAUDE.md`) at the project root to give the agent project-specific instructions, such as build commands and conventions.

## Security

- **Approvals.** In the default **Auto-edit** mode, ordinary source edits apply automatically. Shell commands need approval, except a few exact read-only ones (`git status`, `git log --oneline`, `dir`, …). Edits to files that run code or configure tooling always need approval, unless you switch to **Full auto**. That includes `.vscode`, `.git`, `.github`, `package.json`, scripts, and linter/test/build configs. Reading likely credential files (`.env`, keys) also needs approval.
- **Settings a repository can't change.** The provider, model, endpoints, API key, shell, and permission mode are only read from your **User** settings, so a project's `.vscode/settings.json` can't redirect your code or switch off approvals.
- **Your data.** Local models keep your code on your machine. Remote endpoints and `:cloud` models receive the files the agent reads. The saved API key is only sent to the endpoint it was saved for. Chats are stored in VS Code's workspace storage; use **GBS Agent: Clear Chat History** to delete them.
- **Treat repository content as untrusted.** The agent is instructed to ignore instructions found in files and command output, but no model is immune to prompt injection. Read approval cards carefully, especially in unfamiliar repositories, and avoid **Full auto** there.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `gbsAgent.provider` | `ollama` | `ollama` or `openai` (any OpenAI-compatible server) |
| `gbsAgent.model` | `deepseek-v4-flash:cloud` | Main agent model |
| `gbsAgent.subagentModel` | *(empty)* | Smaller model for exploration subagents |
| `gbsAgent.ollama.baseUrl` | `http://localhost:11434` | Ollama server |
| `gbsAgent.openai.baseUrl` | `https://router.huggingface.co/v1` | OpenAI-compatible server (local or cloud) |
| `gbsAgent.permissionMode` | `acceptEdits` | `ask`, `acceptEdits`, or `auto` |
| `gbsAgent.contextWindow` | `32768` | Model context size; sent to Ollama as `num_ctx` and used to decide when to compact |
| `gbsAgent.maxOutputTokens` | `8192` | Max tokens per response |
| `gbsAgent.maxSteps` | `60` | Model calls per request before the agent pauses |
| `gbsAgent.commandTimeoutSeconds` | `120` | Default shell command timeout |
| `gbsAgent.shell` | *(empty)* | Shell for commands (default: cmd.exe on Windows, `$SHELL` elsewhere) |

The provider, model, endpoints, permission mode, and shell must be set in **User** settings. Values in a project's `.vscode/settings.json` are ignored.

## Troubleshooting

- **"Could not reach Ollama"**: start Ollama (`ollama serve`) or check `gbsAgent.ollama.baseUrl`.
- **Model not found (HTTP 404)**: run `ollama pull <model>`, or pick a model from the model menu.
- **Slow or out of memory**: use a smaller model, or lower `gbsAgent.contextWindow` to `16384`.
- **The agent doesn't use tools or stops early**: switch to a model trained for tool calling (see [Which models work](#which-models-work)). For llama.cpp, add `--jinja`; for vLLM, add `--enable-auto-tool-choice --tool-call-parser <parser>`.
- **Asked to send a saved API key to a local server**: choose **Cancel**. Local servers don't need the key.
- **Details of what happened**: run **GBS Agent: Show Logs**.

## Development

To work on the extension itself:

```
git clone https://github.com/anandhuremanan/gb-codex
cd gb-codex
npm install
code .
```

- Press <kbd>F5</kbd> to launch an Extension Development Host with the extension loaded. Rebuilds happen automatically through the watch task.
- `npm test` runs the integration tests in a real VS Code instance.

See [architecture.md](architecture.md) for how the agent works.
