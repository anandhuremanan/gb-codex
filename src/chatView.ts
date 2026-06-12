import * as vscode from "vscode";
import {
  findFileInWorkspace,
  readFile,
  writeFile,
  extractFilenameFromMessage,
  extractCodeBlock,
} from "./fileAgent";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "gbs-local-dev.chatView";

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getChatHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "userMessage") {
        await handleUserMessage(message.text, webviewView.webview);
      }
    });
  }
}

// ─── Core agent loop ─────────────────────────────────────────────────────────

async function handleUserMessage(userMessage: string, webview: vscode.Webview) {
  const notify = (text: string) =>
    webview.postMessage({ type: "notify", text });

  // 1. Detect a filename in the message
  const filename = extractFilenameFromMessage(userMessage);
  let fileUri: vscode.Uri | null = null;
  let fileContent: string | null = null;

  if (filename) {
    fileUri = await findFileInWorkspace(filename);

    if (fileUri) {
      fileContent = await readFile(fileUri);
      notify(`📂 Found and reading \`${filename}\`…`);
    } else {
      // File doesn't exist yet — create it in the workspace root
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (root) {
        fileUri = vscode.Uri.joinPath(root, filename);
        notify(`📝 \`${filename}\` not found — will create it.`);
      } else {
        notify(`⚠️ No workspace folder open.`);
      }
    }
  }

  // 2. Build prompt — inject file content as context when available
  const prompt = buildPrompt(userMessage, filename, fileContent);

  // 3. Stream the model response silently (don't show raw code in chat)
  notify("🤔 Thinking…");
  let fullResponse = "";
  await streamOllamaResponse(prompt, (token) => {
    fullResponse += token;
  });
  notify("✔️ Response received.");

  // 4. If a file target exists, extract the code block and write it
  if (fileUri && filename) {
    const code = extractCodeBlock(fullResponse);
    if (code) {
      // Try to open the document first (creates it if needed)
      let doc: vscode.TextDocument;
      try {
        // If file doesn't exist yet, create it on disk first
        try {
          await vscode.workspace.fs.stat(fileUri);
        } catch {
          await writeFile(fileUri, code);
        }

        doc = await vscode.workspace.openTextDocument(fileUri);
      } catch {
        // Fallback: write to disk and open
        await writeFile(fileUri, code);
        doc = await vscode.workspace.openTextDocument(fileUri);
      }

      // Use WorkspaceEdit to replace full content (avoids stale-file conflicts)
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(fileUri, fullRange, code);
      await vscode.workspace.applyEdit(edit);

      // Save the document so it persists to disk
      await doc.save();

      // Show the file in the editor
      await vscode.window.showTextDocument(doc, { preview: false });

      notify(`✅ Wrote updated code to \`${filename}\``);
    } else {
      notify(`⚠️ No code block found in response — file not modified.`);
    }
  }

  // Signal the webview that processing is complete
  webview.postMessage({ type: "done" });
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(
  userMessage: string,
  filename: string | null,
  fileContent: string | null,
): string {
  const systemPrompt = `You are an expert software developer.
When asked to create or modify a file, always respond with the COMPLETE updated file content inside a single fenced code block.
Do not explain before the code block — put any explanation AFTER it.
Never return partial code. Always return the entire file.`;

  if (filename && fileContent !== null) {
    return `${systemPrompt}

Current contents of \`${filename}\`:
\`\`\`
${fileContent}
\`\`\`

User request: ${userMessage}`;
  }

  if (filename && fileContent === null) {
    return `${systemPrompt}

The file \`${filename}\` doesn't exist yet or couldn't be read. Generate its full content from scratch.

User request: ${userMessage}`;
  }

  // No file involved — plain conversation
  return `${systemPrompt}\n\nUser: ${userMessage}`;
}

// ─── Ollama streaming ─────────────────────────────────────────────────────────

async function streamOllamaResponse(
  prompt: string,
  onToken: (token: string) => void,
) {
  let response: Response;
  try {
    response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen2.5-coder:7b",
        prompt,
        stream: true,
      }),
    });
  } catch {
    onToken("\n\n⚠️ Could not reach Ollama at localhost:11434. Is it running?");
    return;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown error");
    onToken(`\n\n⚠️ Ollama returned an error (${response.status}): ${errText}`);
    return;
  }

  // Ollama streams newline-delimited JSON chunks
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    // A single chunk may contain multiple newline-delimited JSON objects
    const lines = decoder.decode(value).split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        if (json.response) {
          onToken(json.response);
        }
      } catch {
        // incomplete chunk — skip
      }
    }
  }
}

// ─── Webview HTML ────────────────────────────────────────────────────────────

function getChatHtml(): string {
  return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }

  /* ── Message list ── */
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .msg {
    max-width: 95%;
    padding: 8px 11px;
    border-radius: 8px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg.user {
    align-self: flex-end;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .msg.assistant {
    align-self: flex-start;
    background: var(--vscode-editor-inactiveSelectionBackground);
    color: var(--vscode-foreground);
  }
  .msg.notify {
    align-self: center;
    font-size: 0.85em;
    opacity: 0.75;
    background: transparent;
    padding: 2px 6px;
    font-style: italic;
    color: var(--vscode-descriptionForeground);
  }

  /* inline code */
  .msg code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background);
    padding: 2px 4px;
    border-radius: 3px;
  }

  /* code blocks */
  .code-block {
    background: var(--vscode-textCodeBlock-background);
    padding: 8px 10px;
    border-radius: 6px;
    margin: 8px 0;
    overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    border: 1px solid var(--vscode-panel-border);
  }
  .code-block code {
    background: none;
    padding: 0;
    border-radius: 0;
  }

  /* ── Thinking indicator ── */
  .thinking span {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--vscode-foreground);
    opacity: 0.4;
    animation: blink 1.2s infinite;
  }
  .thinking span:nth-child(2) { animation-delay: 0.2s; }
  .thinking span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%,80%,100% { opacity: 0.2; } 40% { opacity: 1; } }

  /* ── Input bar ── */
  #input-bar {
    display: flex;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
  }

  #user-input {
    flex: 1;
    resize: none;
    padding: 7px 9px;
    border-radius: 5px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: inherit;
    line-height: 1.4;
    max-height: 120px;
    overflow-y: auto;
  }
  #user-input:focus { outline: 1px solid var(--vscode-focusBorder); }

  #send-btn {
    align-self: flex-end;
    padding: 7px 13px;
    border: none;
    border-radius: 5px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
    font-size: inherit;
  }
  #send-btn:hover { background: var(--vscode-button-hoverBackground); }
  #send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body>

<div id="messages"></div>

<div id="input-bar">
  <textarea id="user-input" rows="1" placeholder="Ask about your code…"></textarea>
  <button id="send-btn">Send</button>
</div>

<script>
  const vscode   = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input    = document.getElementById('user-input');
  const sendBtn  = document.getElementById('send-btn');

  let assistantBubble = null;
  let thinkingEl      = null;

  input.addEventListener('input', function() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  sendBtn.addEventListener('click', sendMessage);

  function sendMessage() {
    var text = input.value.trim();
    if (!text || sendBtn.disabled) return;

    appendBubble('user', text);
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;

    thinkingEl = appendBubble('assistant thinking', '');
    thinkingEl.innerHTML = '<span></span><span></span><span></span>';

    vscode.postMessage({ type: 'userMessage', text: text });
  }

  window.addEventListener('message', function(event) {
    var data = event.data;

    if (data.type === 'notify') {
      appendBubble('notify', data.text);
      return;
    }

    if (data.type === 'token') {
      if (thinkingEl) {
        thinkingEl.className = 'msg assistant';
        thinkingEl.textContent = '';
        assistantBubble = thinkingEl;
        thinkingEl = null;
      }
      assistantBubble.textContent += data.text;
      messages.scrollTop = messages.scrollHeight;
    }

    if (data.type === 'done') {
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      assistantBubble = null;
      sendBtn.disabled = false;
      input.focus();
    }
  });

  function appendBubble(cls, text) {
    var el = document.createElement('div');
    el.className = 'msg ' + cls;
    el.textContent = text;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }
</script>
</body>
</html>`;
}
