import * as vscode from "vscode";
import { runAgent } from "./agent/agentLoop";
import { AgentSessionManager } from "./agent/sessionManager";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "gbs-local-dev.chatView";

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getChatHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      const session = AgentSessionManager.getInstance().getSession();

      if (message.type === "userMessage") {
        if (session.currentExecution) {
          session.currentExecution.cancellationSource.cancel();
          session.currentExecution.cancellationSource.dispose();
          session.currentExecution = undefined;
        }

        session.chatHistory.push({ role: "user", content: message.text });

        const cancellationSource = new vscode.CancellationTokenSource();
        const promise = handleUserMessage(message.text, message.model || "deepseek-v4-flash:cloud", webviewView.webview, cancellationSource.token);
        session.currentExecution = { cancellationSource, promise };

        await promise;
      } else if (message.type === "cancel") {
        if (session.currentExecution) {
          session.currentExecution.cancellationSource.cancel();
          session.currentExecution.cancellationSource.dispose();
          session.currentExecution = undefined;
        }
      } else if (message.type === "requestState") {
        webviewView.webview.postMessage({
          type: "restoreState",
          chatHistory: session.chatHistory,
          isExecuting: !!session.currentExecution
        });
      }
    });
  }
}

// ─── Core agent loop ─────────────────────────────────────────────────────────

async function handleUserMessage(
  userMessage: string,
  model: string,
  webview: vscode.Webview,
  cancellationToken: vscode.CancellationToken
) {
  const notify = (text: string) =>
    webview.postMessage({ type: "notify", text });

  try {
    const finalAnswer = await runAgent(
      userMessage,
      {
        notify,
        token: () => {
          // Raw Ollama JSON tokens are processed internally, not streamed to chat bubbles
        }
      },
      cancellationToken,
      model
    );

    // Save final assistant message in chatHistory
    const session = AgentSessionManager.getInstance().getSession();
    session.chatHistory.push({ role: "assistant", content: finalAnswer });

    // Simulate token streaming to the webview UI for smooth rendering
    const chunkSize = 6;
    for (let i = 0; i < finalAnswer.length; i += chunkSize) {
      if (cancellationToken.isCancellationRequested) {
        break;
      }
      webview.postMessage({
        type: "token",
        text: finalAnswer.slice(i, i + chunkSize)
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } catch (err: any) {
    if (cancellationToken.isCancellationRequested) {
      notify(`⏹️ Agent execution was cancelled.`);
    } else {
      notify(`⚠️ Error: ${err.message || err}`);
    }
  } finally {
    const session = AgentSessionManager.getInstance().getSession();
    session.currentExecution = undefined;
    webview.postMessage({ type: "done" });
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
  /* ── Input bar ── */
  #input-bar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
  }

  .input-row {
    display: flex;
    gap: 6px;
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

  /* Model selection panel */
  /* Model selection panel */
  .model-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.85em;
    opacity: 0.9;
  }

  .provider-model-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .model-row label {
    white-space: nowrap;
    color: var(--vscode-descriptionForeground);
  }

  #provider-select {
    padding: 4px 6px;
    border-radius: 3px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: inherit;
  }
  #provider-select:focus { outline: 1px solid var(--vscode-focusBorder); }

  #model-input {
    flex: 1;
    padding: 4px 6px;
    border-radius: 3px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: inherit;
  }
  #model-input:focus { outline: 1px solid var(--vscode-focusBorder); }

  /* Welcome Card */
  .welcome-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    border-radius: 8px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    margin: 12px 10px;
    color: var(--vscode-foreground);
  }

  .welcome-card h3 {
    margin: 0;
    font-size: 1.1em;
    color: var(--vscode-textLink-foreground);
  }

  .welcome-card p {
    font-size: 0.9em;
    line-height: 1.4;
    opacity: 0.9;
  }
</style>
</head>
<body>

<div id="messages"></div>

<div id="input-bar">
  <div class="model-row">
    <div class="provider-model-row">
      <select id="provider-select">
        <option value="ollama">Ollama</option>
        <option value="hf">Hugging Face</option>
      </select>
      <input type="text" id="model-input" value="deepseek-v4-flash:cloud" placeholder="Model ID/Name" />
    </div>
  </div>
  <div class="input-row">
    <textarea id="user-input" rows="1" placeholder="Ask about your code…"></textarea>
    <button id="send-btn">Send</button>
    <button id="stop-btn" style="display: none; align-self: flex-end; padding: 7px 13px; border: none; border-radius: 5px; background: var(--vscode-errorForeground, #c73737); color: white; cursor: pointer; font-size: inherit;">Stop</button>
  </div>
</div>

<script>
  const vscode   = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input    = document.getElementById('user-input');
  const sendBtn  = document.getElementById('send-btn');
  const stopBtn  = document.getElementById('stop-btn');
  const providerSelect = document.getElementById('provider-select');
  const modelInput = document.getElementById('model-input');

  let assistantBubble = null;
  let thinkingEl      = null;
  let currentNotifyEl = null;

  // Restore state from VS Code state store
  const previousState = vscode.getState() || { chatHistory: [], isExecuting: false, selectedModel: "deepseek-v4-flash:cloud", provider: "ollama" };
  let chatHistory = previousState.chatHistory || [];
  
  if (previousState.selectedModel) {
    modelInput.value = previousState.selectedModel;
  }
  if (previousState.provider) {
    providerSelect.value = previousState.provider;
  }

  // Handle provider changes to update placeholders
  providerSelect.addEventListener('change', function() {
    if (providerSelect.value === 'hf') {
      modelInput.placeholder = 'e.g. Qwen/Qwen2.5-Coder-32B-Instruct';
      if (modelInput.value === 'deepseek-v4-flash:cloud' || modelInput.value === 'gemma4:31b-cloud') {
        modelInput.value = 'Qwen/Qwen2.5-Coder-32B-Instruct';
      }
    } else {
      modelInput.placeholder = 'e.g. deepseek-v4-flash:cloud';
      if (modelInput.value === 'Qwen/Qwen2.5-Coder-32B-Instruct') {
        modelInput.value = 'deepseek-v4-flash:cloud';
      }
    }
    saveState();
  });

  function renderMessages() {
    messages.innerHTML = '';
    if (chatHistory.length === 0) {
      const welcome = document.createElement('div');
      welcome.className = 'welcome-card';
      welcome.innerHTML = 
        '<h3>Welcome to GBS Local Dev Agent! \\u{1F680}</h3>' +
        '<p>I am a tool-driven autonomous coding assistant. I can inspect your project structure, search the workspace, read/write files, and run commands to validate code changes automatically.</p>' +
        '<p>Type a prompt in the box below to get started, and select your preferred model provider (Ollama or Hugging Face Cloud) from the dropdown.</p>';
      messages.appendChild(welcome);
    } else {
      for (const m of chatHistory) {
        appendBubbleDirect(m.cls, m.text);
      }
    }
  }

  renderMessages();

  if (previousState.isExecuting) {
    sendBtn.disabled = true;
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    thinkingEl = appendBubbleDirect('assistant thinking', '');
    thinkingEl.innerHTML = '<span></span><span></span><span></span>';
  }

  // Request state from extension host to ensure sync
  vscode.postMessage({ type: 'requestState' });

  function saveState() {
    vscode.setState({
      chatHistory: chatHistory,
      isExecuting: sendBtn.disabled,
      selectedModel: modelInput.value,
      provider: providerSelect.value
    });
  }

  modelInput.addEventListener('input', saveState);

  input.addEventListener('input', function() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  sendBtn.addEventListener('click', sendMessage);
  stopBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'cancel' });
    appendBubble('notify', '⏹️ Cancelling agent execution...');
    currentNotifyEl = null;
  });

  function sendMessage() {
    var text = input.value.trim();
    if (!text || sendBtn.disabled) return;

    // Remove welcome card if present before adding bubbles
    const welcomeCard = messages.querySelector('.welcome-card');
    if (welcomeCard) welcomeCard.remove();

    appendBubble('user', text);
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'block';

    thinkingEl = appendBubble('assistant thinking', '');
    thinkingEl.innerHTML = '<span></span><span></span><span></span>';
    currentNotifyEl = null;

    const selectedProvider = providerSelect.value;
    const rawModel = modelInput.value.trim();
    const finalModel = selectedProvider === 'hf' ? 'hf:' + rawModel : rawModel;

    vscode.postMessage({ 
      type: 'userMessage', 
      text: text,
      model: finalModel
    });
  }

  window.addEventListener('message', function(event) {
    var data = event.data;

    if (data.type === 'restoreState') {
      chatHistory = [];
      for (const m of data.chatHistory) {
        const bubbleCls = m.role === 'user' ? 'user' : 'assistant';
        chatHistory.push({ cls: bubbleCls, text: m.content });
      }
      renderMessages();
      if (data.isExecuting) {
        sendBtn.disabled = true;
        sendBtn.style.display = 'none';
        stopBtn.style.display = 'block';
        if (!thinkingEl) {
          thinkingEl = appendBubbleDirect('assistant thinking', '');
          thinkingEl.innerHTML = '<span></span><span></span><span></span>';
        }
      } else {
        sendBtn.disabled = false;
        sendBtn.style.display = 'block';
        stopBtn.style.display = 'none';
        if (thinkingEl) {
          thinkingEl.remove();
          thinkingEl = null;
        }
      }
      saveState();
      return;
    }

    if (data.type === 'notify') {
      const welcomeCard = messages.querySelector('.welcome-card');
      if (welcomeCard) welcomeCard.remove();

      if (!currentNotifyEl) {
        currentNotifyEl = appendBubble('notify', data.text);
      } else {
        currentNotifyEl.textContent = data.text;
        // Update notify text in chatHistory
        if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].cls === 'notify') {
          chatHistory[chatHistory.length - 1].text = data.text;
        }
        saveState();
      }
      return;
    }

    if (data.type === 'token') {
      const welcomeCard = messages.querySelector('.welcome-card');
      if (welcomeCard) welcomeCard.remove();

      if (thinkingEl) {
        thinkingEl.className = 'msg assistant';
        thinkingEl.textContent = '';
        assistantBubble = thinkingEl;
        thinkingEl = null;
        chatHistory.push({ cls: 'assistant', text: '' });
      }
      currentNotifyEl = null;
      assistantBubble.textContent += data.text;
      
      // Update last message
      if (chatHistory.length > 0) {
        chatHistory[chatHistory.length - 1].text = assistantBubble.textContent;
      }
      saveState();
      messages.scrollTop = messages.scrollHeight;
    }

    if (data.type === 'done') {
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      assistantBubble = null;
      currentNotifyEl = null;
      sendBtn.disabled = false;
      sendBtn.style.display = 'block';
      stopBtn.style.display = 'none';
      saveState();
      input.focus();
    }
  });

  function appendBubbleDirect(cls, text) {
    var el = document.createElement('div');
    el.className = 'msg ' + cls;
    el.textContent = text;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  function appendBubble(cls, text) {
    var el = appendBubbleDirect(cls, text);
    chatHistory.push({ cls: cls, text: text });
    saveState();
    return el;
  }
</script>
</body>
</html>`;
}
