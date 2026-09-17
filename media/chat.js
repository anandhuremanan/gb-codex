// @ts-check
/* GBS Agent chat webview. The extension host owns all state; this script renders it. */
(function () {
  "use strict";

  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();

  // ─── Icons ────────────────────────────────────────────────────────────────
  const ICONS = {
    plus: '<path d="M8 3v10M3 8h10"/>',
    history: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v2.5H5"/><path d="M8 5v3l2 1.5"/>',
    chevronDown: '<path d="M4 6l4 4 4-4"/>',
    chevronRight: '<path d="M6 4l4 4-4 4"/>',
    send: '<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/>',
    stop: '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
    check: '<path d="M3 8.5l3 3 7-7"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    file: '<path d="M9 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z"/><path d="M9 1.5V5h3.5"/>',
    diff: '<path d="M5 2v7M1.5 5.5h7"/><path d="M8 13.5h6.5"/><circle cx="12" cy="5" r="2"/>',
    sparkle: '<path d="M8 1.5l1.6 4.4L14 7.5l-4.4 1.6L8 13.5l-1.6-4.4L2 7.5l4.4-1.6z"/>',
    bot: '<rect x="2.5" y="5" width="11" height="8" rx="2"/><path d="M8 2v3M5.5 9h.01M10.5 9h.01"/>',
    alert: '<path d="M8 1.8L14.5 13.5h-13z"/><path d="M8 6v3.5M8 11.5h.01"/>',
    info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7.2V11M8 5h.01"/>',
    copy: '<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2"/>',
    cpu: '<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6h2.5M1.5 10h2.5M12 6h2.5M12 10h2.5"/>',
    shield: '<path d="M8 1.5l5.5 2v4c0 3.5-2.4 6-5.5 7-3.1-1-5.5-3.5-5.5-7v-4z"/>',
    trash: '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/>',
    arrowDown: '<path d="M8 3v10M3.5 8.5L8 13l4.5-4.5"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3.5 3.5"/>',
    wand: '<path d="M2 14l8-8M9 2v2M13 6h-2M12 3l-1.5 1.5"/>',
    bug: '<rect x="4.5" y="5" width="7" height="8.5" rx="3.5"/><path d="M8 5V3M2 9h2.5M11.5 9H14M3 5.5l1.8 1.3M13 5.5l-1.8 1.3M3 13l1.8-1.3M13 13l-1.8-1.3"/>',
    beaker: '<path d="M6 1.5v5L2.5 13a1 1 0 0 0 .9 1.5h9.2a1 1 0 0 0 .9-1.5L10 6.5v-5M5 1.5h6"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  const TOOL_LABELS = {
    read_file: "Read",
    edit_file: "Edit",
    write_file: "Write",
    grep: "Search",
    glob: "Find",
    list_dir: "List",
    run_command: "Run",
    todo_write: "Plan",
    task: "Agent",
  };

  const MODE_LABELS = { ask: "Ask first", acceptEdits: "Auto-edit", auto: "Full auto" };
  const MODE_ORDER = ["acceptEdits", "ask", "auto"];
  const MODE_TITLES = {
    ask: "Ask before every edit and command",
    acceptEdits: "Edits apply automatically; commands need approval",
    auto: "Never ask for approval (use with care)",
  };

  const SLASH_COMMANDS = [
    { cmd: "/new", desc: "Start a new chat" },
    { cmd: "/compact", desc: "Summarize the conversation to free context" },
    { cmd: "/help", desc: "Show available commands" },
  ];

  const SUGGESTIONS = [
    { icon: "search", text: "Give me an overview of this codebase and how it's structured" },
    { icon: "bug", text: "Find likely bugs in the file I have open and fix them" },
    { icon: "beaker", text: "Write tests for the file I have open" },
    { icon: "wand", text: "Refactor the selected code for readability" },
  ];

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const $ = (sel, root = document) => /** @type {HTMLElement} */ (root.querySelector(sel));

  function h(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return /** @type {HTMLElement} */ (t.content.firstElementChild);
  }

  function fmtTokens(n) {
    if (!n) {
      return "0";
    }
    if (n < 1000) {
      return String(n);
    }
    if (n < 1_000_000) {
      return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    }
    return `${(n / 1_000_000).toFixed(1)}M`;
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) {
      return `${s}s`;
    }
    const m = Math.floor(s / 60);
    return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  }

  function fmtAgo(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) {
      return "now";
    }
    if (s < 3600) {
      return `${Math.floor(s / 60)}m`;
    }
    if (s < 86400) {
      return `${Math.floor(s / 3600)}h`;
    }
    return `${Math.floor(s / 86400)}d`;
  }

  // ─── Markdown ─────────────────────────────────────────────────────────────
  const FILE_REF = /^(?:\.{0,2}\/)?[\w@.\-/\\]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,7}(?::(\d+)(?:[-:]\d+)?)?$/;

  function inline(text) {
    const codes = [];
    let s = text.replace(/`([^`\n]+)`/g, (_, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, pre, url) => `${pre}<a href="${url}">${url}</a>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w])__([^_\n]+)__(?!\w)/g, "$1<strong>$2</strong>");
    s = s.replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
      const code = codes[Number(i)];
      const m = code.match(FILE_REF);
      if (m && !/^\d/.test(code) && !code.includes("://")) {
        const path = code.replace(/:(\d+)(?:[-:]\d+)?$/, "");
        return `<code class="file-link" data-path="${esc(path)}" data-line="${m[1] || ""}">${esc(code)}</code>`;
      }
      return `<code>${esc(code)}</code>`;
    });
  }

  function codeBlock(lang, code) {
    return `<div class="code"><div class="code-head"><span>${esc(lang || "text")}</span><button data-copy title="Copy">${icon("copy")}<span>Copy</span></button></div><pre><code>${esc(code)}</code></pre></div>`;
  }

  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function renderList(items) {
    let html = "";
    let i = 0;
    while (i < items.length) {
      const base = items[i].indent;
      const ordered = items[i].ordered;
      html += ordered ? "<ol>" : "<ul>";
      while (i < items.length && items[i].indent >= base) {
        const item = items[i];
        i++;
        const children = [];
        while (i < items.length && items[i].indent > base) {
          children.push(items[i]);
          i++;
        }
        html += `<li>${inline(item.text)}${children.length ? renderList(children) : ""}</li>`;
      }
      html += ordered ? "</ol>" : "</ul>";
    }
    return html;
  }

  function splitRow(line) {
    return line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  }

  function markdown(src) {
    const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
    let html = "";
    let i = 0;
    const isBlockStart = (l) =>
      /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || LIST_RE.test(l) || /^\s*>/.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);

    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)/);
      if (fence) {
        const code = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
          code.push(lines[i]);
          i++;
        }
        i++;
        html += codeBlock(fence[2], code.join("\n"));
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        html += `<h${level}>${inline(heading[2])}</h${level}>`;
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        html += "<hr>";
        i++;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        html += `<blockquote>${markdown(quote.join("\n"))}</blockquote>`;
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        let body = "";
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          body += `<tr>${splitRow(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`;
          i++;
        }
        html += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
        continue;
      }
      if (LIST_RE.test(line)) {
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(LIST_RE);
          if (m) {
            items.push({ indent: m[1].replace(/\t/g, "  ").length, ordered: /\d/.test(m[2]), text: m[3] });
            i++;
          } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
            items[items.length - 1].text += ` ${lines[i].trim()}`;
            i++;
          } else {
            break;
          }
        }
        html += renderList(items);
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !(lines[i].includes("|") && TABLE_SEP.test(lines[i + 1] || ""))) {
        para.push(inline(lines[i]));
        i++;
      }
      if (para.length === 0) {
        html += `<p>${inline(line)}</p>`;
        i++;
      } else {
        html += `<p>${para.join("<br>")}</p>`;
      }
    }
    return html;
  }

  // ─── State ────────────────────────────────────────────────────────────────
  const persisted = vscode.getState() || {};
  const state = {
    items: new Map(),
    nodes: new Map(),
    open: new Set(),
    todos: [],
    /** @type {boolean | null} null = collapse automatically once every task is done */
    todosCollapsed: null,
    running: false,
    activity: "",
    turnStartedAt: 0,
    usage: { inputTokens: 0, outputTokens: 0, lastInputTokens: 0 },
    sessions: [],
    sessionId: "",
    title: "",
    config: { provider: "ollama", model: "", subagentModel: "", permissionMode: "acceptEdits", contextWindow: 32768 },
    editor: undefined,
    includeEditor: persisted.includeEditor !== false,
    models: [],
    slashIndex: 0,
  };

  // ─── Layout ───────────────────────────────────────────────────────────────
  const app = $("#app");
  app.innerHTML = `
    <div class="header">
      <button class="session-btn" id="session-btn" title="Chat history">${icon("history")}<span class="title" id="title">New chat</span>${icon("chevronDown")}</button>
      <button class="icon-btn" id="new-btn" title="New chat">${icon("plus")}</button>
      <div class="history" id="history" hidden></div>
    </div>
    <div class="scroll" id="scroll">
      <div class="messages" id="messages"></div>
      <button class="jump" id="jump">${icon("arrowDown")}<span>Latest</span></button>
    </div>
    <div class="dock" id="dock">
      <div id="todos"></div>
      <div id="approvals"></div>
      <div class="activity" id="activity" hidden><span class="spinner"></span><span class="text" id="activity-text"></span><span class="elapsed" id="elapsed"></span></div>
      <div class="composer">
        <div class="ctx-row" id="ctx-row"></div>
        <textarea id="input" rows="1" placeholder="Ask GBS Agent to build, fix, or explain…"></textarea>
        <div class="composer-bar">
          <button class="chip" id="model-chip" title="Model">${icon("cpu")}<span class="label" id="model-label"></span></button>
          <button class="chip" id="mode-chip">${icon("shield")}<span class="label" id="mode-label"></span></button>
          <span class="spacer"></span>
          <span class="meter" id="meter" title=""><span class="ring" id="meter-ring"></span><span id="meter-text"></span></span>
          <button class="send" id="send" title="Send (Enter)">${icon("send")}</button>
        </div>
      </div>
      <div class="popover" id="model-pop" hidden>
        <div class="field"><label>Provider</label>
          <div class="seg" id="provider-seg">
            <button data-provider="ollama">Ollama</button>
            <button data-provider="openai">OpenAI-compatible</button>
          </div>
        </div>
        <div class="field"><label for="model-input">Model</label><input id="model-input" list="model-list" spellcheck="false" /></div>
        <div class="field"><label for="sub-input">Subagent model <span class="hint">— optional; a smaller model saves usage</span></label><input id="sub-input" list="model-list" spellcheck="false" placeholder="Same as main model" /></div>
        <datalist id="model-list"></datalist>
        <div class="pop-actions">
          <button class="btn" id="settings-btn">All settings</button>
          <button class="btn" id="refresh-btn">Refresh models</button>
          <button class="btn primary" id="apply-btn">Apply</button>
        </div>
      </div>
      <div class="slash-menu" id="slash" hidden></div>
    </div>`;

  const els = {
    scroll: $("#scroll"),
    messages: $("#messages"),
    jump: $("#jump"),
    title: $("#title"),
    history: $("#history"),
    todos: $("#todos"),
    approvals: $("#approvals"),
    activity: $("#activity"),
    activityText: $("#activity-text"),
    elapsed: $("#elapsed"),
    ctxRow: $("#ctx-row"),
    input: /** @type {HTMLTextAreaElement} */ ($("#input")),
    send: /** @type {HTMLButtonElement} */ ($("#send")),
    modelLabel: $("#model-label"),
    modeChip: $("#mode-chip"),
    modeLabel: $("#mode-label"),
    meter: $("#meter"),
    meterRing: $("#meter-ring"),
    meterText: $("#meter-text"),
    modelPop: $("#model-pop"),
    modelInput: /** @type {HTMLInputElement} */ ($("#model-input")),
    subInput: /** @type {HTMLInputElement} */ ($("#sub-input")),
    modelList: $("#model-list"),
    slash: $("#slash"),
  };

  els.input.value = persisted.draft || "";

  function saveUiState() {
    vscode.setState({ draft: els.input.value, includeEditor: state.includeEditor });
  }

  // ─── Scrolling ────────────────────────────────────────────────────────────
  let stickToBottom = true;
  els.scroll.addEventListener("scroll", () => {
    const gap = els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight;
    stickToBottom = gap < 60;
    els.jump.classList.toggle("show", !stickToBottom && gap > 300);
  });
  els.jump.addEventListener("click", () => scrollToBottom(true));

  function scrollToBottom(force) {
    if (force || stickToBottom) {
      els.scroll.scrollTop = els.scroll.scrollHeight;
      stickToBottom = true;
      els.jump.classList.remove("show");
    }
  }

  // ─── Rendering: transcript ────────────────────────────────────────────────
  function renderWelcome() {
    const hasItems = state.items.size > 0;
    let welcome = $(".welcome", els.messages);
    if (hasItems) {
      welcome?.remove();
      return;
    }
    if (welcome) {
      return;
    }
    welcome = h(`<div class="welcome">
      <div class="logo">${icon("sparkle")}</div>
      <h2>What are we building?</h2>
      <p>GBS Agent explores your codebase, edits files, and runs commands, and shows you every step.</p>
      <div class="suggestions">${SUGGESTIONS.map(
        (s) => `<button class="suggestion" data-suggest="${esc(s.text)}">${icon(s.icon)}<span>${esc(s.text)}</span></button>`,
      ).join("")}</div>
      <div class="tips"><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline · <kbd>Esc</kbd> stop · <kbd>/</kbd> commands</div>
    </div>`);
    els.messages.appendChild(welcome);
  }

  function statusIcon(status) {
    if (status === "running") {
      return '<span class="spinner"></span>';
    }
    return '<span class="dot"></span>';
  }

  function durationOf(item) {
    if (!item.startedAt) {
      return "";
    }
    const end = item.endedAt || (item.status === "running" ? Date.now() : 0);
    if (!end) {
      return "";
    }
    const ms = end - item.startedAt;
    return ms >= 1000 ? fmtDuration(ms) : "";
  }

  function toolMeta(item) {
    let meta = "";
    if (item.stats && (item.stats.added || item.stats.removed)) {
      meta += `${item.stats.added ? `<span class="add">+${item.stats.added}</span>` : ""}${item.stats.removed ? `<span class="del">−${item.stats.removed}</span>` : ""}`;
    }
    if (item.status === "awaiting") {
      meta += '<span class="badge warn">needs approval</span>';
    } else if (item.status === "denied") {
      meta += '<span class="badge err">denied</span>';
    } else if (item.status === "cancelled") {
      meta += '<span class="badge">cancelled</span>';
    } else if (item.status === "error") {
      meta += '<span class="badge err">failed</span>';
    }
    const d = durationOf(item);
    if (d) {
      meta += `<span class="dur">${d}</span>`;
    }
    if (item.snapshotId && item.path) {
      meta += `<button class="icon-btn" data-diff="${esc(item.snapshotId)}" data-path="${esc(item.path)}" title="View diff">${icon("diff")}</button>`;
    }
    return meta;
  }

  function paintTool(el, item) {
    const label = TOOL_LABELS[item.name] || item.name;
    const hasOutput = !!item.output;
    el.className = `item tool st-${item.status}${state.open.has(item.id) && hasOutput ? " open" : ""}`;
    const clickablePath = item.path && item.name !== "list_dir";
    el.innerHTML = `
      <div class="tool-row" data-toggle="${item.id}">
        <span class="status">${statusIcon(item.status)}</span>
        <span class="tool-label">${esc(label)}</span>
        <span class="tool-title${clickablePath ? " link" : ""}" ${clickablePath ? `data-path="${esc(item.path)}" data-line="${item.line || ""}"` : ""} title="${esc(item.title)}">${esc(item.title)}</span>
        <span class="tool-meta">${toolMeta(item)}</span>
        ${hasOutput ? `<span class="chev">${icon("chevronRight")}</span>` : ""}
      </div>
      ${item.live && item.status === "running" ? `<pre class="tool-live">${esc(item.live)}</pre>` : ""}
      ${hasOutput ? `<div class="tool-output"><pre>${esc(item.output)}</pre></div>` : ""}`;
    const live = $(".tool-live", el);
    if (live) {
      live.scrollTop = live.scrollHeight;
    }
  }

  function paintAgent(el, item) {
    const sub = item.subagent || { type: "explore", toolUses: 0 };
    const running = item.status === "running";
    // Subagents expand by default while running so progress is visible; collapse once done unless the user opened them.
    const isOpen = state.open.has(item.id) || (running && !state.open.has(`closed:${item.id}`));
    el.className = `item agent-card st-${item.status}${isOpen ? " open" : ""}`;

    let children = $(".agent-children", el);
    if (!children) {
      el.innerHTML = `
        <div class="agent-head" data-toggle="${item.id}"></div>
        <div class="agent-activity"></div>
        <div class="agent-body"><div class="agent-children"></div><div class="agent-result-wrap"></div></div>`;
      children = $(".agent-children", el);
    }
    const typeLabel = sub.type === "general" ? "Agent" : "Explore";
    const uses = `${sub.toolUses} tool${sub.toolUses === 1 ? "" : "s"}`;
    const d = durationOf(item);
    $(".agent-head", el).innerHTML = `
      <span class="status">${statusIcon(item.status)}</span>
      <span class="agent-icon">${icon("bot")}</span>
      <span class="badge">${typeLabel}</span>
      <span class="agent-desc" title="${esc(item.title)}">${esc(item.title)}</span>
      <span class="tool-meta">${item.status === "error" ? '<span class="badge err">failed</span>' : ""}${item.status === "cancelled" ? '<span class="badge">cancelled</span>' : ""}<span>${uses}</span>${d ? `<span>${d}</span>` : ""}</span>
      <span class="chev">${icon("chevronRight")}</span>`;
    const activity = $(".agent-activity", el);
    activity.hidden = !running || !sub.activity;
    activity.textContent = sub.activity || "";
    const resultWrap = $(".agent-result-wrap", el);
    resultWrap.innerHTML =
      item.output && !running
        ? `<div class="agent-result-label">Report</div><div class="agent-result md">${markdown(item.output)}</div>`
        : "";
  }

  function paintAssistant(el, item) {
    el.className = `item msg-assistant${item.streaming ? " streaming" : ""}`;
    let thinking = /** @type {HTMLDetailsElement} */ ($(".thinking", el));
    let body = $(".md", el);
    if (!body) {
      el.innerHTML = `<details class="thinking" hidden><summary>${icon("chevronRight")}<span class="label"></span></summary><div class="thinking-body"></div></details><div class="md"></div>`;
      thinking = /** @type {HTMLDetailsElement} */ ($(".thinking", el));
      body = $(".md", el);
    }
    const hasThinking = !!(item.thinking && item.thinking.trim());
    thinking.hidden = !hasThinking;
    if (hasThinking) {
      const label = $(".label", thinking);
      const active = item.streaming && !item.text;
      label.textContent = active ? "Thinking…" : "Thought process";
      label.classList.toggle("shimmer", active);
      $(".thinking-body", thinking).textContent = item.thinking;
    }
    body.innerHTML = markdown(item.text);
  }

  function paintSummary(el, item) {
    el.className = "item summary";
    const parts = [`Worked for ${fmtDuration(item.durationMs)}`];
    if (item.inputTokens || item.outputTokens) {
      parts.push(`${fmtTokens(item.inputTokens)} in · ${fmtTokens(item.outputTokens)} out`);
    }
    let files = "";
    if (item.files && item.files.length) {
      const added = item.files.reduce((a, f) => a + f.added, 0);
      const removed = item.files.reduce((a, f) => a + f.removed, 0);
      files = `<div class="changed">
        <div class="changed-head">${item.files.length} file${item.files.length === 1 ? "" : "s"} changed <span class="add">+${added}</span> <span class="del">−${removed}</span></div>
        ${item.files
          .map(
            (f) => `<div class="changed-file">
              ${icon("file")}
              <span class="name" data-path="${esc(f.path)}" title="${esc(f.path)}">${esc(f.path)}</span>
              ${f.created ? '<span class="badge">new</span>' : ""}
              <span class="tool-meta">${f.added ? `<span class="add">+${f.added}</span>` : ""}${f.removed ? `<span class="del">−${f.removed}</span>` : ""}</span>
              ${f.snapshotId ? `<button class="icon-btn" data-diff="${esc(f.snapshotId)}" data-path="${esc(f.path)}" title="Diff against the version before this turn">${icon("diff")}</button>` : ""}
            </div>`,
          )
          .join("")}
      </div>`;
    }
    el.innerHTML = `${files}<div class="summary-line">${esc(parts.join(" · "))}</div>`;
  }

  function paint(el, item) {
    switch (item.kind) {
      case "user":
        el.className = "item msg-user";
        el.textContent = item.text;
        break;
      case "assistant":
        paintAssistant(el, item);
        break;
      case "tool":
        if (item.name === "task") {
          paintAgent(el, item);
        } else {
          paintTool(el, item);
        }
        break;
      case "notice":
        el.className = `item notice ${item.level}`;
        el.innerHTML = `${icon(item.level === "info" ? "info" : "alert")}<div>${inline(item.text)}</div>`;
        break;
      case "summary":
        paintSummary(el, item);
        break;
    }
  }

  function upsert(item) {
    state.items.set(item.id, item);
    let el = state.nodes.get(item.id);
    if (!el) {
      el = document.createElement("div");
      el.dataset.id = item.id;
      state.nodes.set(item.id, el);
      const parent = item.parentId && state.nodes.get(item.parentId);
      const container = parent ? $(".agent-children", parent) : null;
      (container || els.messages).appendChild(el);
    }
    paint(el, item);
  }

  function removeItem(id) {
    state.items.delete(id);
    state.nodes.get(id)?.remove();
    state.nodes.delete(id);
  }

  function resetTranscript(items) {
    state.items.clear();
    state.nodes.clear();
    els.messages.innerHTML = "";
    for (const item of items) {
      upsert(item);
    }
    renderWelcome();
  }

  // ─── Rendering: dock ──────────────────────────────────────────────────────
  function renderTodos() {
    const todos = state.todos || [];
    if (!todos.length) {
      els.todos.innerHTML = "";
      return;
    }
    const done = todos.filter((t) => t.status === "completed").length;
    const current = todos.find((t) => t.status === "in_progress");
    const allDone = done === todos.length;
    const stale = !state.running && !allDone;
    const collapsed = state.todosCollapsed ?? (allDone && !state.running);
    els.todos.innerHTML = `
      <div class="todos${collapsed ? " collapsed" : ""}${stale ? " stale" : ""}">
        <div class="todos-head" data-todos-toggle>
          <span class="chev">${icon("chevronRight")}</span>
          <span>${collapsed && current && !stale ? esc(current.content) : "Tasks"}</span>
          ${stale ? '<span class="badge" title="The agent stopped before finishing these items">not finished</span>' : ""}
          <span class="progress"><i></i></span>
          <span class="count">${done}/${todos.length}</span>
        </div>
        <ul>${todos
          .map(
            (t) => `<li class="todo ${t.status}"><span class="box">${t.status === "completed" ? icon("check") : ""}</span><span>${esc(t.content)}</span></li>`,
          )
          .join("")}</ul>
      </div>`;
    /** @type {HTMLElement} */ ($(".progress i", els.todos)).style.width = `${Math.round((done / todos.length) * 100)}%`;
  }

  let approvalKey = "";
  function renderApprovals() {
    const pending = [...state.items.values()].filter((i) => i.kind === "tool" && i.status === "awaiting" && i.approval);
    // Only rebuild when the set changes, so streaming updates never swallow a click on these buttons.
    const key = pending.map((i) => i.id).join(",");
    if (key === approvalKey) {
      return;
    }
    approvalKey = key;
    els.approvals.innerHTML = pending
      .map((item) => {
        const isCommand = item.approval.kind === "command";
        return `<div class="approval" data-approval="${item.id}">
          <div class="approval-title">${icon("shield")}<span>${isCommand ? "Run this command?" : "Allow this edit?"}</span></div>
          <pre class="approval-detail">${esc(item.approval.detail)}</pre>
          <div class="approval-actions">
            <button class="btn primary" data-approve="once" data-id="${item.id}">${isCommand ? "Run" : "Allow"}</button>
            <button class="btn" data-approve="always" data-id="${item.id}">${inline(item.approval.alwaysLabel || "Always allow")}</button>
            <button class="btn danger" data-approve="deny" data-id="${item.id}">Deny</button>
          </div>
        </div>`;
      })
      .join("");
  }

  function renderActivity() {
    els.activity.hidden = !state.running;
    els.activityText.textContent = state.activity || "Working…";
    els.elapsed.textContent = state.turnStartedAt ? fmtDuration(Date.now() - state.turnStartedAt) : "";
  }

  function renderComposer() {
    const hasText = els.input.value.trim().length > 0;
    if (state.running && !hasText) {
      els.send.className = "send stop";
      els.send.innerHTML = icon("stop");
      els.send.title = "Stop (Esc)";
      els.send.disabled = false;
    } else {
      els.send.className = "send";
      els.send.innerHTML = icon("send");
      els.send.title = state.running ? "Queue message (Enter) — the agent will read it at its next step" : "Send (Enter)";
      els.send.disabled = !hasText;
    }
    els.input.placeholder = state.running ? "Add guidance for the running agent…" : "Ask GBS Agent to build, fix, or explain…";
  }

  function renderConfig() {
    const c = state.config;
    els.modelLabel.textContent = c.model || "Select model";
    $("#model-chip").title = `${c.provider === "openai" ? "OpenAI-compatible" : "Ollama"} · ${c.model}${c.subagentModel ? `\nSubagents: ${c.subagentModel}` : ""}`;
    els.modeLabel.textContent = MODE_LABELS[c.permissionMode] || c.permissionMode;
    els.modeChip.title = `${MODE_TITLES[c.permissionMode] || ""} — click to change`;
    els.modeChip.classList.toggle("mode-auto", c.permissionMode === "auto");
    renderMeter();
  }

  function renderMeter() {
    const u = state.usage || {};
    const window = state.config.contextWindow || 32768;
    const pct = Math.min(100, Math.round(((u.lastInputTokens || 0) / window) * 100));
    els.meterRing.style.setProperty("--pct", String(pct));
    els.meterRing.style.setProperty("--meter-color", pct > 80 ? "var(--err)" : pct > 60 ? "var(--warn)" : "var(--link)");
    els.meterText.textContent = u.lastInputTokens ? `${pct}%` : "";
    els.meter.title = `Context: ${fmtTokens(u.lastInputTokens || 0)} / ${fmtTokens(window)} tokens in the last request${pct > 60 ? " — consider /compact or a new chat" : ""}\nSession total: ${fmtTokens(u.inputTokens || 0)} in · ${fmtTokens(u.outputTokens || 0)} out`;
  }

  function renderEditorChip() {
    const e = state.editor;
    if (!e) {
      els.ctxRow.innerHTML = "";
      return;
    }
    const label = e.selection ? `${e.path}:${e.selection}` : e.path;
    els.ctxRow.innerHTML = `<span class="ctx-chip${state.includeEditor ? "" : " off"}" title="${state.includeEditor ? "The agent will see which file is open and any selected code" : "Editor context will not be sent"}">
      ${icon("file")}<span class="name">${esc(label)}</span>
      <button data-toggle-editor title="${state.includeEditor ? "Don't include" : "Include"}">${icon(state.includeEditor ? "x" : "plus")}</button>
    </span>`;
  }

  function renderHeader() {
    els.title.textContent = state.title || "New chat";
  }

  function renderHistory() {
    const sessions = state.sessions || [];
    els.history.innerHTML = sessions.length
      ? sessions
          .map(
            (s) => `<div class="history-item${s.id === state.sessionId ? " active" : ""}" data-session="${esc(s.id)}">
              <span class="t">${esc(s.title || "New chat")}</span><span class="d">${fmtAgo(s.updatedAt)}</span>
              <button class="icon-btn" data-delete-session="${esc(s.id)}" title="Delete">${icon("trash")}</button>
            </div>`,
          )
          .join("")
      : '<div class="history-empty">No previous chats</div>';
  }

  function renderSlash() {
    const value = els.input.value;
    const match = /^\/\S*$/.test(value) ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(value.toLowerCase())) : [];
    if (!match.length) {
      els.slash.hidden = true;
      return;
    }
    state.slashIndex = Math.min(state.slashIndex, match.length - 1);
    els.slash.hidden = false;
    els.slash.innerHTML = match
      .map(
        (c, i) => `<button class="slash-item${i === state.slashIndex ? " active" : ""}" data-slash="${c.cmd}"><span class="cmd">${c.cmd}</span><span class="desc">${esc(c.desc)}</span></button>`,
      )
      .join("");
  }

  // ─── Host messages ────────────────────────────────────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "init":
        state.sessionId = msg.sessionId;
        state.title = msg.title;
        state.todos = msg.todos || [];
        state.usage = msg.usage || state.usage;
        state.running = !!msg.running;
        state.activity = msg.activity || "";
        state.turnStartedAt = msg.turnStartedAt || 0;
        state.sessions = msg.sessions || [];
        state.config = msg.config || state.config;
        state.editor = msg.editor;
        state.open.clear();
        resetTranscript(msg.items || []);
        renderAll();
        scrollToBottom(true);
        break;
      case "patch": {
        for (const item of msg.items || []) {
          upsert(item);
        }
        for (const id of msg.removed || []) {
          removeItem(id);
        }
        if (msg.activity !== undefined) {
          state.activity = msg.activity;
        }
        if (msg.usage) {
          state.usage = msg.usage;
        }
        if (msg.title !== undefined) {
          state.title = msg.title;
        }
        renderWelcome();
        renderApprovals();
        renderActivity();
        renderMeter();
        renderHeader();
        scrollToBottom(false);
        break;
      }
      case "running":
        state.running = !!msg.running;
        if (msg.turnStartedAt) {
          state.turnStartedAt = msg.turnStartedAt;
        }
        if (msg.activity !== undefined) {
          state.activity = msg.activity;
        }
        if (!state.running) {
          state.turnStartedAt = 0;
          state.activity = "";
        }
        renderActivity();
        renderComposer();
        renderApprovals();
        renderTodos();
        break;
      case "todos":
        if (!(state.todos || []).length) {
          state.todosCollapsed = null;
        }
        state.todos = msg.todos || [];
        renderTodos();
        break;
      case "sessions":
        state.sessions = msg.sessions || [];
        if (msg.title !== undefined) {
          state.title = msg.title;
        }
        renderHistory();
        renderHeader();
        break;
      case "config":
        state.config = msg.config;
        renderConfig();
        break;
      case "editor":
        state.editor = msg.editor;
        renderEditorChip();
        break;
      case "models":
        state.models = msg.models || [];
        els.modelList.innerHTML = state.models.map((m) => `<option value="${esc(m)}"></option>`).join("");
        $("#refresh-btn").textContent = state.models.length ? `Refresh (${state.models.length})` : "No models found";
        break;
    }
  });

  function renderAll() {
    renderHeader();
    renderHistory();
    renderTodos();
    renderApprovals();
    renderActivity();
    renderComposer();
    renderConfig();
    renderEditorChip();
  }

  setInterval(() => {
    if (!state.running) {
      return;
    }
    renderActivity();
    for (const item of state.items.values()) {
      if (item.kind === "tool" && item.status === "running") {
        const el = state.nodes.get(item.id);
        const dur = el && $(item.name === "task" ? ".agent-head .tool-meta" : ".tool-meta", el);
        if (dur) {
          paint(el, item);
        }
      }
    }
  }, 1000);

  // ─── Actions ──────────────────────────────────────────────────────────────
  function send(text) {
    const value = (text ?? els.input.value).trim();
    if (!value) {
      return;
    }
    vscode.postMessage({ type: "send", text: value, includeEditor: state.includeEditor });
    if (text === undefined) {
      els.input.value = "";
      autosize();
      saveUiState();
    }
    els.slash.hidden = true;
    stickToBottom = true;
    renderComposer();
  }

  function autosize() {
    els.input.style.height = "auto";
    els.input.style.height = `${Math.min(els.input.scrollHeight, 240)}px`;
  }

  els.input.addEventListener("input", () => {
    autosize();
    renderComposer();
    renderSlash();
    saveUiState();
  });

  els.input.addEventListener("keydown", (e) => {
    if (!els.slash.hidden) {
      const items = els.slash.querySelectorAll(".slash-item");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        state.slashIndex = (state.slashIndex + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        renderSlash();
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const chosen = /** @type {HTMLElement} */ (items[state.slashIndex]);
        if (chosen) {
          els.input.value = "";
          send(chosen.dataset.slash);
          renderComposer();
        }
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      if (state.running) {
        vscode.postMessage({ type: "stop" });
      }
      els.slash.hidden = true;
    }
  });

  els.send.addEventListener("click", () => {
    if (state.running && !els.input.value.trim()) {
      vscode.postMessage({ type: "stop" });
    } else {
      send();
    }
  });

  $("#new-btn").addEventListener("click", () => vscode.postMessage({ type: "newChat" }));

  $("#session-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    renderHistory();
    els.history.hidden = !els.history.hidden;
  });

  $("#model-chip").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!els.modelPop.hidden) {
      els.modelPop.hidden = true;
      return;
    }
    els.modelInput.value = state.config.model || "";
    els.subInput.value = state.config.subagentModel || "";
    setProviderSeg(state.config.provider);
    els.modelPop.hidden = false;
    els.modelInput.focus();
    els.modelInput.select();
    vscode.postMessage({ type: "listModels" });
  });

  let pendingProvider = "ollama";
  function setProviderSeg(provider) {
    pendingProvider = provider;
    document.querySelectorAll("#provider-seg button").forEach((b) => {
      b.classList.toggle("active", /** @type {HTMLElement} */ (b).dataset.provider === provider);
    });
  }

  $("#provider-seg").addEventListener("click", (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest("button");
    if (btn && btn.dataset.provider && btn.dataset.provider !== pendingProvider) {
      setProviderSeg(btn.dataset.provider);
      vscode.postMessage({ type: "setConfig", config: { provider: pendingProvider } });
      els.modelList.innerHTML = "";
      setTimeout(() => vscode.postMessage({ type: "listModels" }), 150);
    }
  });

  function applyModel() {
    vscode.postMessage({
      type: "setConfig",
      config: { provider: pendingProvider, model: els.modelInput.value, subagentModel: els.subInput.value },
    });
    els.modelPop.hidden = true;
    els.input.focus();
  }

  $("#apply-btn").addEventListener("click", applyModel);
  [els.modelInput, els.subInput].forEach((input) =>
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyModel();
      } else if (e.key === "Escape") {
        els.modelPop.hidden = true;
      }
    }),
  );
  $("#refresh-btn").addEventListener("click", () => vscode.postMessage({ type: "listModels" }));
  $("#settings-btn").addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));

  els.modeChip.addEventListener("click", () => {
    const next = MODE_ORDER[(MODE_ORDER.indexOf(state.config.permissionMode) + 1) % MODE_ORDER.length];
    state.config = { ...state.config, permissionMode: next };
    renderConfig();
    vscode.postMessage({ type: "setConfig", config: { permissionMode: next } });
  });

  document.addEventListener("click", async (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    if (!target.closest("#history") && !target.closest("#session-btn")) {
      els.history.hidden = true;
    }
    if (!target.closest("#model-pop") && !target.closest("#model-chip")) {
      els.modelPop.hidden = true;
    }

    const approve = target.closest("[data-approve]");
    if (approve) {
      const el = /** @type {HTMLElement} */ (approve);
      el.closest(".approval")?.remove();
      vscode.postMessage({ type: "approve", id: el.dataset.id, decision: el.dataset.approve });
      return;
    }

    const copy = target.closest("[data-copy]");
    if (copy) {
      const code = copy.closest(".code")?.querySelector("pre")?.textContent || "";
      try {
        await navigator.clipboard.writeText(code);
        const label = copy.querySelector("span");
        if (label) {
          label.textContent = "Copied";
          setTimeout(() => (label.textContent = "Copy"), 1200);
        }
      } catch {
        /* clipboard unavailable */
      }
      return;
    }

    const diff = target.closest("[data-diff]");
    if (diff) {
      const el = /** @type {HTMLElement} */ (diff);
      vscode.postMessage({ type: "openDiff", snapshotId: el.dataset.diff, path: el.dataset.path });
      return;
    }

    const fileLink = target.closest("[data-path]");
    if (fileLink && !target.closest("[data-diff]")) {
      const el = /** @type {HTMLElement} */ (fileLink);
      vscode.postMessage({ type: "openFile", path: el.dataset.path, line: el.dataset.line });
      return;
    }

    const toggle = target.closest("[data-toggle]");
    if (toggle) {
      const id = /** @type {HTMLElement} */ (toggle).dataset.toggle;
      const item = state.items.get(id);
      if (item) {
        const el = state.nodes.get(id);
        const isOpen = el.classList.contains("open");
        if (isOpen) {
          state.open.delete(id);
          state.open.add(`closed:${id}`);
        } else {
          state.open.add(id);
          state.open.delete(`closed:${id}`);
        }
        paint(el, item);
      }
      return;
    }

    if (target.closest("[data-todos-toggle]")) {
      const collapsedNow = !!els.todos.querySelector(".todos.collapsed");
      state.todosCollapsed = !collapsedNow;
      renderTodos();
      return;
    }

    if (target.closest("[data-toggle-editor]")) {
      state.includeEditor = !state.includeEditor;
      saveUiState();
      renderEditorChip();
      return;
    }

    const suggestion = target.closest("[data-suggest]");
    if (suggestion) {
      els.input.value = /** @type {HTMLElement} */ (suggestion).dataset.suggest || "";
      autosize();
      renderComposer();
      els.input.focus();
      return;
    }

    const del = target.closest("[data-delete-session]");
    if (del) {
      e.stopPropagation();
      vscode.postMessage({ type: "deleteSession", id: /** @type {HTMLElement} */ (del).dataset.deleteSession });
      return;
    }

    const sessionRow = target.closest("[data-session]");
    if (sessionRow) {
      els.history.hidden = true;
      vscode.postMessage({ type: "switchSession", id: /** @type {HTMLElement} */ (sessionRow).dataset.session });
      return;
    }

    const slash = target.closest("[data-slash]");
    if (slash) {
      els.input.value = "";
      send(/** @type {HTMLElement} */ (slash).dataset.slash);
      renderComposer();
    }
  });

  // ─── Boot ─────────────────────────────────────────────────────────────────
  renderAll();
  renderWelcome();
  autosize();
  vscode.postMessage({ type: "ready" });
  els.input.focus();
})();
