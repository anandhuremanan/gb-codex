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

## Using the agent

### Asking for work

Type what you want and press <kbd>Enter</kbd> (<kbd>Shift</kbd>+<kbd>Enter</kbd> for a newline). Treat it like briefing a colleague: say what should change and how you'll know it worked.

> Add rate limiting to the login endpoint, 5 attempts per minute per IP, and make sure the auth tests still pass.

- **The file you have open is attached** automatically, along with any selected code. The chip above the input shows what will be sent; click the × to leave it out.
- **You can keep typing while it works.** Your message is delivered at the agent's next step, so you can redirect it without stopping: *"actually, put it in middleware instead"*.
- **Stop any time** with <kbd>Esc</kbd> or the stop button. Finished edits stay; nothing is rolled back.
- On an empty chat, the suggestion buttons are a quick way to start (overview of the codebase, find bugs, write tests, refactor the selection).

### Watching it work

Every step is visible, so you can catch a wrong turn early:

- **Tool rows** — one line per action: `Read src/auth.ts`, `Search "login"`, `Run npm test`. Click a row to see the full result, and a file name to open it.
- **Agent cards** — when the task needs broad exploration, the agent delegates to subagents that search in their own context and report back. The card shows their progress and final report, so that bulk output never enters the main conversation.
- **Live command output** — long-running commands stream their output into the row as it appears.
- **Task checklist** — for multi-step work the agent keeps a plan above the input, ticking items off. If it stops early, the list is marked *not finished*.
- **Thinking** — models that expose reasoning get a collapsed *Thought process* section.
- The status line shows what's happening right now and how long the turn has taken.

### Approving actions

Shell commands, and edits to files that run code or configure tooling, pause for approval. The card shows the full command (or a preview of the edit) plus warnings when a command chains several programs, reaches the network, redirects output, or contains invisible characters.

- **Run / Allow** — just this once.
- **Always allow `npm test`** — remembers that command for the rest of the session. Not offered for risky or sensitive cases.
- **Deny** — the agent is told and adapts instead of retrying.

The permission chip under the input switches the overall mode: **Auto-edit** (default), **Ask first**, or **Full auto**. See [Security](#security) for what each mode still checks.

### Reviewing changes

- Each turn ends with a summary: how long it took, tokens used, and every file changed with `+`/`−` counts.
- The diff icon opens VS Code's diff view comparing the file with its state **before the turn**.
- When a file is open in the editor, edits go through the editor buffer and are saved, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes them as usual. Files that aren't open are written directly — use the diff view or git to review those.
- `path:line` references in the chat are clickable.
- Code blocks have a copy button.

### Managing context and cost

The meter next to the send button shows how full the model's context window is (hover for the session's token totals).

- **`/compact`** summarizes the conversation so far and frees space; useful when the meter turns orange.
- **`/new`** starts a fresh chat, which is cheaper than compacting when you switch to an unrelated task.
- **Past chats** are under the chat title; use **GBS Agent: Clear Chat History** to delete them all.
- Set `gbsAgent.subagentModel` to a smaller model so exploration runs cheaply.

### Giving the agent project knowledge

- **`AGENTS.md`** (or `CLAUDE.md`) at the project root is read on every request. Keep it short: build and test commands, conventions, things that are always true.
- **Skills** are for bigger knowledge that only matters sometimes. See below.

## Skills

A skill is a folder with a `SKILL.md` that teaches the agent something specific to your team or project: how to use your component library, the conventions of one service, the domain rules of an application. Skills stay cheap because only the name and description are always in the prompt (~45 tokens each); the instructions load when the agent decides they apply, and bundled reference files load only if the task needs them.

### Adding one

Run **GBS Agent: New Skill**, or create the folder yourself:

```
.gbs/skills/component-library/
├── SKILL.md            # index: when to use it, the rules that matter
└── references/
    └── forms.md        # detail, loaded only when the task needs it
```

```markdown
---
name: component-library
description: Builds UI with the GBS component library. Use when adding or changing UI in apps that import @gbs/ui.
autoAttach: ["src/**/*.tsx"]      # optional: marks the skill relevant for these files
---

# Component library
- Tables: `DataGrid`, never a raw `<table>`.
- Forms: wrap every input in `FormField`.
- Import from `@gbs/ui`, never from `@gbs/ui/dist/*`.

Details: see references/forms.md
```

Keep `SKILL.md` under 500 lines and move the rest into files beside it, so a small task never loads your whole guide. Write the `description` so it says **what it covers and when to use it** — that one line is how the agent decides to load it.

### Where skills can live

| Location | Use for | Shared with |
|---|---|---|
| `.gbs/skills/` (or `.claude/skills/`) in the project | This project's domain, conventions, requirements | Everyone who clones the repo |
| A dependency that lists `"gbsSkills": ["skills/<name>"]` in its package.json | A library shipping its own usage guide, versioned with the code | Everyone who installs the package |
| Your personal skills folder (**GBS Agent: Open Skills Folder**, or `gbsAgent.skillsPath`) | Habits, and company-wide skills you want in every project | Just you, unless that folder is a shared repo |

If the same name appears twice, the project wins over a package, and a package wins over your personal folder.

### Using them

- The agent loads a skill by itself when the description matches the task; you'll see a `Skill` row in the transcript.
- **`/skills`** lists what's available, where each came from, and what the catalog costs per request. The skills chip under the input shows the count and offers **Reload** after you edit one.
- `autoAttach` globs tell the agent a skill is relevant to the file you're in, which helps smaller local models pick the right one.
- Skills from a repository or a dependency are instructions the agent will follow, so the first time a workspace offers them you're asked once. **GBS Agent: Reload Skills** asks again.
- A skill missing its `name` or `description` is listed as invalid in the chip and never sent to the model.

## Commands

From the Command Palette (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>):

| Command | What it does |
|---|---|
| **GBS Agent: New Chat** | Starts a fresh conversation |
| **GBS Agent: Stop Agent** | Stops the running agent |
| **GBS Agent: Set API Key** | Stores a key in secret storage, bound to the current endpoint |
| **GBS Agent: Clear Chat History** | Deletes all stored chats for this workspace |
| **GBS Agent: New Skill** | Scaffolds a skill folder and opens it |
| **GBS Agent: Open Skills Folder** | Opens your personal skills folder |
| **GBS Agent: Reload Skills** | Re-reads skills and asks again about repository skills |
| **GBS Agent: Show Logs** | Opens the log (requests, token usage, errors) |

In the chat input: `/new`, `/compact`, `/skills`, `/help`.

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
| `gbsAgent.permissionMode` | `acceptEdits` | `ask`, `acceptEdits`, or `auto` |
| `gbsAgent.ollama.baseUrl` | `http://localhost:11434` | Ollama server |
| `gbsAgent.openai.baseUrl` | `https://router.huggingface.co/v1` | OpenAI-compatible server (local or cloud) |
| `gbsAgent.contextWindow` | `32768` | Model context size; sent to Ollama as `num_ctx` and used to decide when to compact |
| `gbsAgent.maxOutputTokens` | `8192` | Max tokens per response |
| `gbsAgent.temperature` | `0.2` | Sampling temperature |
| `gbsAgent.maxSteps` | `60` | Model calls per request before the agent pauses |
| `gbsAgent.commandTimeoutSeconds` | `120` | Default shell command timeout |
| `gbsAgent.maxToolOutputChars` | `20000` | Tool results longer than this are truncated before the model sees them |
| `gbsAgent.shell` | *(empty)* | Shell for commands (default: cmd.exe on Windows, `$SHELL` elsewhere) |
| `gbsAgent.skills.enabled` | `true` | Use skills at all |
| `gbsAgent.skillsPath` | *(empty)* | Your personal skills folder (default: the extension's own folder) |

The provider, model, endpoints, permission mode, shell, and skills path must be set in **User** settings. Values in a project's `.vscode/settings.json` are ignored for those. API keys belong in secret storage via **GBS Agent: Set API Key**; the older `openai.apiKey` and `huggingfaceToken` settings still work but are deprecated.

## Troubleshooting

- **"Could not reach Ollama"**: start Ollama (`ollama serve`) or check `gbsAgent.ollama.baseUrl`.
- **Model not found (HTTP 404)**: run `ollama pull <model>`, or pick a model from the model menu.
- **Slow or out of memory**: use a smaller model, or lower `gbsAgent.contextWindow` to `16384`.
- **The agent doesn't use tools or stops early**: switch to a model trained for tool calling (see [Which models work](#which-models-work)). For llama.cpp, add `--jinja`; for vLLM, add `--enable-auto-tool-choice --tool-call-parser <parser>`.
- **A skill isn't being used**: check `/skills` — it may be invalid or not allowed for this workspace (**Reload Skills** re-asks). Otherwise make the `description` name the trigger words you actually use, or add an `autoAttach` glob for the files it applies to.
- **Skill edits aren't picked up**: skills are read once per request; run **Reload Skills** or use the Reload button in the skills chip.
- **Too many approval prompts**: use **Always allow** for commands you repeat, and keep the mode on **Auto-edit**. Sensitive files always ask.
- **The context meter is high**: run `/compact`, or `/new` if you're switching tasks.
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
