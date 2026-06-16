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
        const promise = handleUserMessage(message.text, webviewView.webview, cancellationSource.token);
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
      cancellationToken
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
  <button id="stop-btn" style="display: none; align-self: flex-end; padding: 7px 13px; border: none; border-radius: 5px; background: var(--vscode-errorForeground, #c73737); color: white; cursor: pointer; font-size: inherit;">Stop</button>
</div>

<script>
  const vscode   = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input    = document.getElementById('user-input');
  const sendBtn  = document.getElementById('send-btn');
  const stopBtn  = document.getElementById('stop-btn');

  let assistantBubble = null;
  let thinkingEl      = null;
  let currentNotifyEl = null;

  // Restore state from VS Code state store
  const previousState = vscode.getState() || { chatHistory: [], isExecuting: false };
  let chatHistory = previousState.chatHistory || [];

  for (const m of chatHistory) {
    appendBubbleDirect(m.cls, m.text);
  }

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
      isExecuting: sendBtn.disabled
    });
  }

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

    appendBubble('user', text);
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'block';

    thinkingEl = appendBubble('assistant thinking', '');
    thinkingEl.innerHTML = '<span></span><span></span><span></span>';
    currentNotifyEl = null;

    vscode.postMessage({ type: 'userMessage', text: text });
  }

  window.addEventListener('message', function(event) {
    var data = event.data;

    if (data.type === 'restoreState') {
      messages.innerHTML = '';
      chatHistory = [];
      for (const m of data.chatHistory) {
        const bubbleCls = m.role === 'user' ? 'user' : 'assistant';
        appendBubbleDirect(bubbleCls, m.content);
        chatHistory.push({ cls: bubbleCls, text: m.content });
      }
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
