import * as vscode from "vscode";
import { AgentConfig, getApiKey, readConfig, updateConfig } from "../config";
import { AdaptiveProvider } from "../llm/adaptiveProvider";
import { CancelledError, isAbortError } from "../llm/http";
import { OllamaProvider } from "../llm/ollama";
import { OpenAICompatibleProvider } from "../llm/openai";
import { LlmProvider, Usage, newId } from "../llm/types";
import { Agent, AgentHost, ApprovalDecision } from "../agent/agent";
import { compactIfNeeded, elidePreviousTurns, repairToolResults } from "../agent/compaction";
import { PermissionPolicy } from "../agent/permissions";
import { getEnvironment, systemPromptFor } from "../agent/prompts";
import { SnapshotStore } from "../agent/snapshots";
import { toolSets } from "../agent/tools";
import { SubagentRequest } from "../agent/tools/types";
import { ChangedFile, Todo, ToolItem, TranscriptItem } from "../agent/transcript";
import { lineDiffStats, relPath, resolvePath } from "../agent/workspace";
import { SessionStore, StoredSession } from "./store";

export interface ChatView {
  post(message: unknown): void;
  isVisible(): boolean;
  reveal(): void;
}

interface TurnState {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
  files: Map<string, ChangedFile & { original: string }>;
}

const FLUSH_MS = 40;
const SAVE_DEBOUNCE_MS = 1500;

function emptySession(): StoredSession {
  const now = Date.now();
  return {
    id: newId("chat"),
    title: "",
    createdAt: now,
    updatedAt: now,
    messages: [],
    items: [],
    todos: [],
    usage: { inputTokens: 0, outputTokens: 0, lastInputTokens: 0 },
  };
}

/** Owns the active chat session: runs the agent, keeps the transcript, and syncs the webview. */
export class SessionController implements AgentHost, vscode.Disposable {
  readonly permissions = new PermissionPolicy();

  private session: StoredSession;
  private readonly itemIndex = new Map<string, TranscriptItem>();
  private view?: ChatView;
  private abort?: AbortController;
  private runPromise?: Promise<void>;
  private turn?: TurnState;
  private activity = "";
  private queued: string[] = [];
  private readonly approvals = new Map<string, (decision: ApprovalDecision) => void>();
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();
  private metaDirty = false;
  private flushTimer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SessionStore,
    private readonly snapshots: SnapshotStore,
    private readonly output: vscode.OutputChannel,
  ) {
    const activeId = store.activeId;
    this.session = (activeId && store.load(activeId)) || emptySession();
    this.indexItems();

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("gbsAgent")) {
          this.post({ type: "config", config: this.uiConfig() });
          if (e.affectsConfiguration("gbsAgent.shell")) {
            void getEnvironment(this.config.shell, true);
          }
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.postEditorContext()),
      vscode.window.onDidChangeTextEditorSelection(() => this.postEditorContext()),
    );
  }

  get config(): AgentConfig {
    return readConfig();
  }

  get running(): boolean {
    return !!this.abort;
  }

  // ─── View wiring ────────────────────────────────────────────────────────────

  attachView(view: ChatView): void {
    this.view = view;
  }

  detachView(): void {
    this.view = undefined;
  }

  private post(message: unknown): void {
    this.view?.post(message);
  }

  private postInit(): void {
    this.post({
      type: "init",
      sessionId: this.session.id,
      title: this.session.title,
      items: this.session.items,
      todos: this.session.todos,
      usage: this.session.usage,
      running: this.running,
      activity: this.activity,
      turnStartedAt: this.turn?.startedAt,
      sessions: this.store.list(),
      config: this.uiConfig(),
      editor: this.editorContextInfo(),
    });
  }

  private uiConfig() {
    const c = this.config;
    return {
      provider: c.provider,
      model: c.model,
      subagentModel: c.subagentModel,
      permissionMode: c.permissionMode,
      contextWindow: c.contextWindow,
    };
  }

  private editorTimer?: NodeJS.Timeout;
  private postEditorContext(): void {
    clearTimeout(this.editorTimer);
    this.editorTimer = setTimeout(() => this.post({ type: "editor", editor: this.editorContextInfo() }), 150);
  }

  private editorContextInfo(): { path: string; selection?: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
      return undefined;
    }
    const sel = editor.selection;
    return {
      path: relPath(editor.document.uri),
      selection: sel.isEmpty ? undefined : `${sel.start.line + 1}-${sel.end.line + 1}`,
    };
  }

  private editorContextPrompt(): string {
    const editor = vscode.window.activeTextEditor;
    const info = this.editorContextInfo();
    if (!editor || !info) {
      return "";
    }
    const sel = editor.selection;
    if (sel.isEmpty) {
      return `\n\n<editor_context>The user has ${info.path} open (cursor at line ${sel.active.line + 1}).</editor_context>`;
    }
    let text = editor.document.getText(sel);
    if (text.length > 6000) {
      text = `${text.slice(0, 6000)}\n[selection truncated]`;
    }
    return `\n\n<editor_context>The user has ${info.path} open with lines ${info.selection} selected:\n\`\`\`\n${text}\n\`\`\`\n</editor_context>`;
  }

  // ─── Webview messages ───────────────────────────────────────────────────────

  async handleMessage(msg: any): Promise<void> {
    try {
      switch (msg?.type) {
        case "ready":
          this.postInit();
          break;
        case "send":
          await this.send(String(msg.text ?? ""), msg.includeEditor !== false);
          break;
        case "stop":
          this.stop();
          break;
        case "newChat":
          await this.newChat();
          break;
        case "switchSession":
          await this.switchSession(String(msg.id));
          break;
        case "deleteSession":
          await this.deleteSession(String(msg.id));
          break;
        case "approve":
          this.resolveApproval(String(msg.id), msg.decision);
          break;
        case "openFile":
          await this.openFile(String(msg.path), Number(msg.line) || undefined);
          break;
        case "openDiff":
          await this.openDiff(String(msg.snapshotId), String(msg.path));
          break;
        case "setConfig":
          await this.setConfig(msg.config ?? {});
          break;
        case "listModels":
          this.post({ type: "models", models: await this.listModels() });
          break;
        case "openSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", "gbsAgent");
          break;
      }
    } catch (err) {
      this.notice("error", err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Session lifecycle ──────────────────────────────────────────────────────

  async send(rawText: string, includeEditor = true): Promise<void> {
    const text = rawText.trim();
    if (!text) {
      return;
    }
    if (text.startsWith("/")) {
      const [command] = text.split(/\s+/);
      switch (command.toLowerCase()) {
        case "/new":
        case "/clear":
          await this.newChat();
          return;
        case "/compact":
          await this.compact();
          return;
        case "/help":
          this.notice(
            "info",
            "Commands: /new — start a new chat · /compact — summarize the conversation to free context · /help. Press Esc to stop a running agent.",
          );
          return;
      }
    }

    this.addItem({ kind: "user", id: newId("user"), text });
    if (!this.session.title) {
      this.session.title = text.replace(/\s+/g, " ").slice(0, 60);
      this.metaDirty = true;
    }
    const content = includeEditor ? text + this.editorContextPrompt() : text;
    if (this.running) {
      this.queued.push(content);
      return;
    }
    this.startTurn(content);
  }

  private startTurn(content: string): void {
    this.runPromise = this.runTurn(content);
  }

  stop(): void {
    this.abort?.abort();
  }

  /** Stops the current run and waits for it to unwind, so late updates can't leak into another session. */
  private async stopAndWait(): Promise<void> {
    this.stop();
    await this.runPromise?.catch(() => undefined);
  }

  async newChat(): Promise<void> {
    await this.stopAndWait();
    await this.persist();
    this.session = emptySession();
    this.permissions.reset();
    this.indexItems();
    await this.store.setActive(this.session.id);
    this.postInit();
  }

  private async switchSession(id: string): Promise<void> {
    if (id === this.session.id) {
      return;
    }
    const loaded = this.store.load(id);
    if (!loaded) {
      this.post({ type: "sessions", sessions: this.store.list() });
      return;
    }
    await this.stopAndWait();
    await this.persist();
    this.session = loaded;
    this.indexItems();
    await this.store.setActive(id);
    this.postInit();
  }

  private async deleteSession(id: string): Promise<void> {
    await this.store.delete(id);
    if (id === this.session.id) {
      await this.stopAndWait();
      this.session = emptySession();
      this.indexItems();
      this.postInit();
    } else {
      this.post({ type: "sessions", sessions: this.store.list() });
    }
  }

  private indexItems(): void {
    this.itemIndex.clear();
    this.dirty.clear();
    this.removed.clear();
    this.queued = [];
    for (const item of this.session.items) {
      // Anything left "running" from a previous window is stale.
      if (item.kind === "tool" && (item.status === "running" || item.status === "awaiting")) {
        item.status = "cancelled";
        item.approval = undefined;
        item.live = undefined;
      }
      if (item.kind === "assistant") {
        item.streaming = false;
      }
      this.itemIndex.set(item.id, item);
    }
  }

  private async runTurn(content: string): Promise<void> {
    const session = this.session;
    const abort = new AbortController();
    this.abort = abort;
    this.turn = { startedAt: Date.now(), inputTokens: 0, outputTokens: 0, files: new Map() };
    this.activity = "Starting…";
    this.post({ type: "running", running: true, turnStartedAt: this.turn.startedAt, activity: this.activity });

    const messages = session.messages;
    repairToolResults(messages);
    if (messages.length) {
      elidePreviousTurns(messages);
    }
    messages.push({ role: "user", content });

    try {
      const cfg = this.config;
      const provider = this.createProvider("main");
      const agent = new Agent({
        kind: "main",
        provider,
        tools: toolSets.main,
        systemPrompt: await systemPromptFor("main", cfg.shell),
        messages,
        host: this,
        signal: abort.signal,
        maxSteps: cfg.maxSteps,
      });
      await agent.run();
    } catch (err) {
      if (abort.signal.aborted || isAbortError(err)) {
        this.notice("info", "Stopped.");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`[run] error: ${message}`);
        this.notice("error", friendlyError(message, this.config));
      }
    } finally {
      this.finishTurn(session, abort);
    }
  }

  private finishTurn(session: StoredSession, abort: AbortController): void {
    for (const [id, resolve] of this.approvals) {
      resolve("deny");
      this.approvals.delete(id);
    }
    for (const item of this.itemIndex.values()) {
      if (item.kind === "tool" && (item.status === "running" || item.status === "awaiting")) {
        this.updateItem(item.id, { status: "cancelled", endedAt: Date.now(), approval: undefined, live: undefined });
      } else if (item.kind === "assistant" && item.streaming) {
        this.finishAssistant(item.id);
      }
    }
    repairToolResults(session.messages);

    const turn = this.turn;
    if (turn && session === this.session) {
      const durationMs = Date.now() - turn.startedAt;
      const files = [...turn.files.values()].map(({ original: _original, ...file }) => file);
      if (files.length || durationMs > 4000) {
        this.addItem({
          kind: "summary",
          id: newId("summary"),
          durationMs,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          files,
        });
      }
    }

    if (this.abort === abort) {
      this.abort = undefined;
      this.turn = undefined;
      this.activity = "";
    }
    session.updatedAt = Date.now();
    this.flush();
    this.post({ type: "running", running: this.running });
    void this.persist(session);

    if (!this.running && this.queued.length && session === this.session) {
      this.startTurn(this.queued.splice(0).join("\n\n"));
    }
  }

  private async compact(): Promise<void> {
    if (this.running) {
      this.notice("warning", "Wait for the agent to finish (or stop it) before compacting.");
      return;
    }
    if (this.session.messages.length < 4) {
      this.notice("info", "The conversation is already short; nothing to compact.");
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    this.activity = "Compacting conversation…";
    this.post({ type: "running", running: true, turnStartedAt: Date.now(), activity: this.activity });
    try {
      const cfg = this.config;
      repairToolResults(this.session.messages);
      await compactIfNeeded({
        messages: this.session.messages,
        systemPrompt: await systemPromptFor("main", cfg.shell),
        tools: [],
        contextWindow: cfg.contextWindow,
        maxOutputTokens: cfg.maxOutputTokens,
        provider: this.createProvider("main"),
        signal: abort.signal,
        force: true,
        log: (m) => this.log(m),
      });
      this.session.usage.lastInputTokens = 0;
      this.notice("info", "Conversation compacted. Earlier details were summarized to free up context.");
    } catch (err) {
      if (!isAbortError(err)) {
        this.notice("error", `Compaction failed: ${err instanceof Error ? err.message : err}`);
      }
    } finally {
      this.abort = undefined;
      this.activity = "";
      this.flush();
      this.post({ type: "running", running: false });
      void this.persist();
      if (this.queued.length) {
        this.startTurn(this.queued.splice(0).join("\n\n"));
      }
    }
  }

  private async persist(session = this.session): Promise<void> {
    clearTimeout(this.saveTimer);
    try {
      await this.store.save(session);
      if (session === this.session) {
        await this.store.setActive(session.id);
      }
      this.post({ type: "sessions", sessions: this.store.list(), sessionId: this.session.id, title: this.session.title });
    } catch (err) {
      this.log(`[store] failed to save session: ${err}`);
    }
  }

  private saveSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), SAVE_DEBOUNCE_MS);
  }

  // ─── AgentHost ──────────────────────────────────────────────────────────────

  createProvider(kind: "main" | "subagent"): LlmProvider {
    const cfg = this.config;
    const model = (kind === "subagent" && cfg.subagentModel) || cfg.model;
    if (!model) {
      throw new Error("No model configured. Pick a model from the model menu below the chat input.");
    }
    const inner =
      cfg.provider === "openai"
        ? new OpenAICompatibleProvider({
            baseUrl: cfg.openaiBaseUrl,
            model,
            maxOutputTokens: cfg.maxOutputTokens,
            temperature: cfg.temperature,
            getApiKey: () => getApiKey(this.context.secrets, true),
          })
        : new OllamaProvider({
            baseUrl: cfg.ollamaBaseUrl,
            model,
            contextWindow: cfg.contextWindow,
            maxOutputTokens: cfg.maxOutputTokens,
            temperature: cfg.temperature,
          });
    return new AdaptiveProvider(inner, (m) => this.log(m));
  }

  async runSubagent(request: SubagentRequest): Promise<string> {
    const cfg = this.config;
    const messages = [{ role: "user" as const, content: request.prompt }];
    const agent = new Agent({
      kind: request.type,
      provider: this.createProvider("subagent"),
      tools: toolSets[request.type],
      systemPrompt: await systemPromptFor(request.type, cfg.shell),
      messages,
      host: this,
      signal: request.signal,
      maxSteps: Math.min(cfg.maxSteps, 40),
      parentItemId: request.parentItemId,
    });
    this.updateSubagent(request.parentItemId, "Starting…");
    const report = (await agent.run()).trim();
    return report || "(The subagent finished without a report.)";
  }

  addItem(item: TranscriptItem): void {
    this.session.items.push(item);
    this.itemIndex.set(item.id, item);
    this.markDirty(item.id);
    if (item.kind === "tool" && item.parentId) {
      const parent = this.itemIndex.get(item.parentId);
      if (parent?.kind === "tool" && parent.subagent) {
        parent.subagent.toolUses++;
        this.updateSubagent(parent.id, `${item.name.replace(/_/g, " ")} ${item.title}`);
      }
    }
  }

  private updateSubagent(id: string, activity: string): void {
    const parent = this.itemIndex.get(id);
    if (parent?.kind === "tool" && parent.subagent) {
      parent.subagent.activity = activity;
      this.markDirty(id);
    }
  }

  updateItem(id: string, patch: Partial<ToolItem>): void {
    const item = this.itemIndex.get(id) as unknown as Record<string, unknown> | undefined;
    if (!item) {
      return;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete item[key];
      } else {
        item[key] = value;
      }
    }
    this.markDirty(id);
  }

  appendAssistant(id: string, text: string, thinking: string): void {
    const item = this.itemIndex.get(id);
    if (item?.kind !== "assistant") {
      return;
    }
    item.text += text;
    if (thinking) {
      item.thinking = (item.thinking ?? "") + thinking;
    }
    this.markDirty(id);
  }

  finishAssistant(id: string): void {
    const item = this.itemIndex.get(id);
    if (item?.kind !== "assistant") {
      return;
    }
    item.streaming = false;
    if (!item.text.trim() && !item.thinking?.trim()) {
      this.removeItem(id);
    } else {
      this.markDirty(id);
    }
  }

  private removeItem(id: string): void {
    this.itemIndex.delete(id);
    const index = this.session.items.findIndex((i) => i.id === id);
    if (index >= 0) {
      this.session.items.splice(index, 1);
    }
    this.dirty.delete(id);
    this.removed.add(id);
    this.scheduleFlush();
  }

  setActivity(text: string): void {
    if (this.activity !== text) {
      this.activity = text;
      this.metaDirty = true;
      this.scheduleFlush();
    }
  }

  recordUsage(usage: Usage | undefined, isMain: boolean): void {
    if (!usage) {
      return;
    }
    const u = this.session.usage;
    u.inputTokens += usage.inputTokens;
    u.outputTokens += usage.outputTokens;
    if (isMain && usage.inputTokens) {
      u.lastInputTokens = usage.inputTokens;
    }
    if (this.turn) {
      this.turn.inputTokens += usage.inputTokens;
      this.turn.outputTokens += usage.outputTokens;
    }
    this.metaDirty = true;
    this.scheduleFlush();
  }

  requestApproval(itemId: string, signal: AbortSignal): Promise<ApprovalDecision> {
    if (this.view && !this.view.isVisible()) {
      this.view.reveal();
    } else if (!this.view) {
      void vscode.commands.executeCommand("gbs-local-dev.chatView.focus");
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.approvals.delete(itemId);
        reject(new CancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.approvals.set(itemId, (decision) => {
        signal.removeEventListener("abort", onAbort);
        this.approvals.delete(itemId);
        resolve(decision);
      });
    });
  }

  private resolveApproval(id: string, decision: unknown): void {
    const resolve = this.approvals.get(id);
    if (resolve) {
      resolve(decision === "always" || decision === "once" ? decision : "deny");
    }
  }

  drainQueuedMessages(): string[] {
    return this.queued.splice(0);
  }

  hasQueuedMessages(): boolean {
    return this.queued.length > 0;
  }

  setTodos(todos: Todo[]): void {
    this.session.todos = todos;
    this.post({ type: "todos", todos });
  }

  recordFileChange(uri: vscode.Uri, before: string | undefined, after: string): string {
    const snapshotId = this.snapshots.put(before ?? "");
    const path = relPath(uri);
    if (this.turn) {
      let file = this.turn.files.get(path);
      if (!file) {
        file = { path, added: 0, removed: 0, created: before === undefined, original: before ?? "", snapshotId };
        this.turn.files.set(path, file);
      }
      Object.assign(file, lineDiffStats(file.original, after));
    }
    return snapshotId;
  }

  log(message: string): void {
    this.output.appendLine(`${new Date().toISOString().slice(11, 19)} ${message}`);
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.addItem({ kind: "notice", id: newId("notice"), level, text });
    this.flush();
  }

  // ─── Batched UI updates ─────────────────────────────────────────────────────

  private markDirty(id: string): void {
    this.dirty.add(id);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    }
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.dirty.size && !this.removed.size && !this.metaDirty) {
      return;
    }
    const items = [...this.dirty].map((id) => this.itemIndex.get(id)).filter(Boolean);
    this.post({
      type: "patch",
      items,
      removed: [...this.removed],
      activity: this.activity,
      usage: this.session.usage,
      title: this.session.title,
    });
    this.dirty.clear();
    this.removed.clear();
    this.metaDirty = false;
    this.saveSoon();
  }

  // ─── Editor integration ─────────────────────────────────────────────────────

  private async openFile(path: string, line?: number): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = resolvePath(path);
      await vscode.workspace.fs.stat(uri);
    } catch {
      return; // not a real file reference (e.g. inline code that only looks like a path)
    }
    const position = line ? new vscode.Position(Math.max(0, line - 1), 0) : undefined;
    try {
      await vscode.window.showTextDocument(uri, {
        preview: true,
        selection: position ? new vscode.Range(position, position) : undefined,
      });
    } catch {
      this.notice("warning", `Could not open ${path}.`);
    }
  }

  private async openDiff(snapshotId: string, path: string): Promise<void> {
    if (!this.snapshots.has(snapshotId)) {
      vscode.window.showInformationMessage("The original version is no longer available (snapshots are kept in memory for this window only).");
      return;
    }
    const current = resolvePath(path);
    await vscode.commands.executeCommand("vscode.diff", this.snapshots.uri(snapshotId, path), current, `${path} (before ↔ after)`);
  }

  private async setConfig(config: Record<string, unknown>): Promise<void> {
    const keys: Record<string, string> = {
      provider: "provider",
      model: "model",
      subagentModel: "subagentModel",
      permissionMode: "permissionMode",
    };
    for (const [key, value] of Object.entries(config)) {
      if (keys[key] && typeof value === "string") {
        await updateConfig(keys[key], value.trim());
      }
    }
    this.post({ type: "config", config: this.uiConfig() });
  }

  private async listModels(): Promise<string[]> {
    const cfg = this.config;
    try {
      if (cfg.provider === "ollama") {
        const res = await fetch(`${cfg.ollamaBaseUrl.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(4000) });
        const json: any = await res.json();
        return (json.models ?? []).map((m: any) => String(m.name)).sort();
      }
      const key = await getApiKey(this.context.secrets, false);
      const res = await fetch(`${cfg.openaiBaseUrl.replace(/\/+$/, "")}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(6000),
      });
      const json: any = await res.json();
      return (json.data ?? []).map((m: any) => String(m.id)).sort().slice(0, 500);
    } catch (err) {
      this.log(`[models] could not list models: ${err}`);
      return [];
    }
  }

  dispose(): void {
    this.stop();
    clearTimeout(this.flushTimer);
    clearTimeout(this.editorTimer);
    void this.persist();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function friendlyError(message: string, cfg: AgentConfig): string {
  if (/Could not reach Ollama/i.test(message)) {
    return `${message}\n\nStart Ollama (\`ollama serve\`) or change the base URL in settings (gbsAgent.ollama.baseUrl).`;
  }
  if (/HTTP 404/.test(message) && cfg.provider === "ollama" && /model/i.test(message)) {
    return `${message}\n\nThe model "${cfg.model}" isn't available locally. Run \`ollama pull ${cfg.model}\` or pick another model.`;
  }
  if (/HTTP 401|HTTP 403/.test(message)) {
    return `${message}\n\nCheck your API key (command: "GBS Agent: Set API Key").`;
  }
  return message;
}
