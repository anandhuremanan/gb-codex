import * as vscode from "vscode";
import { CancelledError, isAbortError, throwIfAborted } from "../llm/http";
import { LlmMessage, LlmProvider, ToolCall, ToolSpec, Usage, newId } from "../llm/types";
import { compactIfNeeded } from "./compaction";
import { collectDiagnostics } from "./diagnostics";
import { PermissionPolicy } from "./permissions";
import { Todo, ToolItem, TranscriptItem } from "./transcript";
import { Tool, ToolContext, ToolHost, ToolState } from "./tools/types";
import { truncateMiddle } from "./workspace";

export type AgentKind = "main" | "explore" | "general";
export type ApprovalDecision = "once" | "always" | "deny";

/** Everything the loop needs from the session: UI updates, approvals, usage accounting. */
export interface AgentHost extends ToolHost {
  readonly permissions: PermissionPolicy;
  addItem(item: TranscriptItem): void;
  appendAssistant(id: string, text: string, thinking: string): void;
  finishAssistant(id: string): void;
  setActivity(text: string): void;
  recordUsage(usage: Usage | undefined, isMain: boolean): void;
  requestApproval(itemId: string, signal: AbortSignal): Promise<ApprovalDecision>;
  /** Messages the user sent while the agent was running (main agent only). */
  drainQueuedMessages(): string[];
  hasQueuedMessages(): boolean;
  /** The session checklist, so the loop can catch a final answer that leaves it stale. */
  getTodos(): Todo[];
  log(message: string): void;
}

export interface AgentOptions {
  kind: AgentKind;
  provider: LlmProvider;
  tools: Tool[];
  systemPrompt: string;
  /** Conversation history; mutated in place. */
  messages: LlmMessage[];
  host: AgentHost;
  signal: AbortSignal;
  maxSteps: number;
  /** Transcript item that nested tool items attach to (subagents). */
  parentItemId?: string;
}

interface ChangeSet {
  uris: Map<string, vscode.Uri>;
  count: number;
}

const MAX_CONTINUATIONS = 2;
const TOOL_OUTPUT_PREVIEW = 8000;

export class Agent {
  private readonly state: ToolState = { readVersions: new Map() };
  private readonly toolMap: Map<string, Tool>;
  private readonly specs: ToolSpec[];
  private readonly repeatCounts = new Map<string, number>();

  constructor(private readonly options: AgentOptions) {
    this.toolMap = new Map(options.tools.map((t) => [t.name, t]));
    this.specs = options.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  private get isMain(): boolean {
    return this.options.kind === "main";
  }

  async run(): Promise<string> {
    const { host, messages, signal, provider } = this.options;
    let continuations = 0;
    let lastText = "";
    let remindedAboutTodos = false;

    for (let step = 1; step <= this.options.maxSteps; step++) {
      throwIfAborted(signal);
      if (this.isMain) {
        for (const text of host.drainQueuedMessages()) {
          messages.push({ role: "user", content: text });
        }
      }

      await compactIfNeeded({
        messages,
        systemPrompt: this.options.systemPrompt,
        tools: this.specs,
        contextWindow: host.config.contextWindow,
        maxOutputTokens: host.config.maxOutputTokens,
        provider,
        signal,
        log: (m) => host.log(m),
        onSummarizing: () => this.activity("Compacting conversation…"),
      });

      this.activity("Thinking…");
      const assistantId = this.isMain ? newId("assistant") : undefined;
      if (assistantId) {
        host.addItem({ kind: "assistant", id: assistantId, text: "", streaming: true });
      }
      let result;
      try {
        let responding = false;
        result = await provider.chat(
          { messages: [{ role: "system", content: this.options.systemPrompt }, ...messages], tools: this.specs, signal },
          {
            onText: (delta) => {
              if (assistantId) {
                host.appendAssistant(assistantId, delta, "");
              }
              if (!responding) {
                responding = true;
                this.activity("Responding…");
              }
            },
            onThinking: (delta) => assistantId && host.appendAssistant(assistantId, "", delta),
          },
        );
      } finally {
        if (assistantId) {
          host.finishAssistant(assistantId);
        }
      }
      host.recordUsage(result.usage, this.isMain);
      host.log(
        `[${this.options.kind}] step ${step}: ${result.toolCalls.length} tool call(s), usage in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"}`,
      );

      messages.push({
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      });
      if (result.text.trim()) {
        lastText = result.text;
      }

      if (result.toolCalls.length === 0) {
        if (result.stopReason === "length" && continuations < MAX_CONTINUATIONS) {
          continuations++;
          messages.push({
            role: "user",
            content: "Your previous response hit the output token limit. Continue exactly where you left off.",
          });
          continue;
        }
        if (this.isMain && host.hasQueuedMessages()) {
          // The user sent more input while the model was answering; handle it in the same run.
          continue;
        }
        const openTodos = this.isMain ? host.getTodos().filter((t) => t.status !== "completed") : [];
        if (openTodos.length && !remindedAboutTodos) {
          // Models often forget the final todo_write; one short reminder keeps the checklist truthful.
          remindedAboutTodos = true;
          messages.push({
            role: "user",
            content: `<system-reminder>Your task list still has ${openTodos.length} unfinished item(s): ${openTodos
              .map((t) => `"${t.content}"`)
              .join(", ")}. If they are done, call todo_write to mark them completed. If work remains, continue it. If an item was dropped, update the list and briefly say why. Do not repeat your previous summary.</system-reminder>`,
          });
          continue;
        }
        return result.text.trim() ? result.text : lastText;
      }
      continuations = 0;

      const toolMessages = await this.executeToolCalls(result.toolCalls);
      messages.push(...toolMessages);
    }

    const note = `Stopped after ${this.options.maxSteps} steps (the configured limit). Send "continue" to keep going.`;
    if (this.isMain) {
      host.addItem({ kind: "notice", id: newId("notice"), level: "warning", text: note });
    }
    return lastText ? `${lastText}\n\n${note}` : note;
  }

  private activity(text: string): void {
    if (this.isMain) {
      this.options.host.setActivity(text);
    }
  }

  /** Runs consecutive concurrency-safe calls in parallel and everything else sequentially, preserving order. */
  private async executeToolCalls(calls: ToolCall[]): Promise<LlmMessage[]> {
    const { signal, host } = this.options;
    const results: LlmMessage[] = new Array(calls.length);
    const changed: ChangeSet = { uris: new Map(), count: 0 };
    let lastMutatingIndex = -1;

    let i = 0;
    while (i < calls.length) {
      throwIfAborted(signal);
      if (this.isSafe(calls[i])) {
        let j = i;
        while (j < calls.length && this.isSafe(calls[j])) {
          j++;
        }
        const batch = calls.slice(i, j);
        const outputs = await Promise.all(batch.map((call) => this.runTool(call, changed)));
        outputs.forEach((out, k) => (results[i + k] = out));
        i = j;
      } else {
        const changesBefore = changed.count;
        results[i] = await this.runTool(calls[i], changed);
        if (changed.count > changesBefore) {
          lastMutatingIndex = i;
        }
        i++;
      }
    }

    if (changed.uris.size && lastMutatingIndex >= 0) {
      this.activity("Checking diagnostics…");
      const report = await collectDiagnostics([...changed.uris.values()], signal);
      if (report) {
        results[lastMutatingIndex].content += report;
      }
      host.log(`[diagnostics] ${changed.uris.size} file(s): ${report ? "errors reported" : "clean"}`);
    }
    return results;
  }

  private isSafe(call: ToolCall): boolean {
    const tool = this.toolMap.get(call.name);
    if (!tool) {
      return true;
    }
    return tool.isConcurrencySafe ? tool.isConcurrencySafe(call.arguments as never) : tool.readOnly;
  }

  private async runTool(call: ToolCall, changed: ChangeSet): Promise<LlmMessage> {
    const { host, signal, parentItemId } = this.options;
    const tool = this.toolMap.get(call.name);
    const args = call.arguments ?? {};
    const itemId = newId("tool");
    const reply = (content: string): LlmMessage => ({ role: "tool", content, toolCallId: call.id, toolName: call.name });

    let title = call.name;
    try {
      title = tool ? tool.title(args as never) || call.name : call.name;
    } catch {
      // title is cosmetic
    }
    const item: ToolItem = {
      kind: "tool",
      id: itemId,
      parentId: parentItemId,
      name: call.name,
      title: truncateMiddle(title.replace(/\s+/g, " "), 160),
      status: "running",
      startedAt: Date.now(),
    };
    if (call.name === "task") {
      const type = (args as { subagent_type?: string }).subagent_type === "general" ? "general" : "explore";
      item.subagent = { type, toolUses: 0 };
    }
    host.addItem(item);
    if (this.isMain) {
      host.setActivity(`${call.name === "task" ? "Delegating" : "Running"}: ${item.title}`);
    }

    const fail = (content: string, status: ToolItem["status"] = "error") => {
      host.updateItem(itemId, { status, endedAt: Date.now(), output: content });
      return reply(content);
    };

    if (!tool) {
      return fail(`Unknown tool "${call.name}". Available tools: ${[...this.toolMap.keys()].join(", ")}.`);
    }
    if (call.invalidArguments !== undefined) {
      return fail(`Invalid JSON arguments for ${call.name}: ${call.invalidArguments.slice(0, 300)}. Send valid JSON.`);
    }
    const missing = (tool.parameters.required ?? []).filter((key) => (args as Record<string, unknown>)[key] === undefined);
    if (missing.length) {
      return fail(`Missing required parameter(s) for ${call.name}: ${missing.join(", ")}.`);
    }

    let permission;
    try {
      permission = tool.permission?.(args as never);
    } catch (err) {
      return fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (permission && host.permissions.needsApproval(permission, host.config.permissionMode)) {
      host.updateItem(itemId, {
        status: "awaiting",
        approval: {
          kind: permission.kind,
          detail: permission.detail,
          preview: permission.preview,
          alwaysLabel: host.permissions.describeAlways(permission),
        },
      });
      if (this.isMain) {
        host.setActivity("Waiting for your approval…");
      }
      const decision = await host.requestApproval(itemId, signal);
      host.updateItem(itemId, { approval: undefined });
      if (decision === "deny") {
        return fail(
          "The user denied this action. Do not retry it; choose a different approach or ask the user how to proceed.",
          "denied",
        );
      }
      if (decision === "always") {
        host.permissions.allowAlways(permission);
      }
      host.updateItem(itemId, { status: "running", startedAt: Date.now() });
    }

    const ctx: ToolContext = {
      signal,
      state: this.state,
      host,
      itemId,
      fileChanged: (uri) => {
        changed.uris.set(uri.toString(), uri);
        changed.count++;
      },
    };

    try {
      const result = await tool.execute(args as never, ctx);
      let content = truncateMiddle(result.content, host.config.maxToolOutputChars);

      const key = `${call.name}:${JSON.stringify(args)}:${content.length}`;
      const repeats = (this.repeatCounts.get(key) ?? 0) + 1;
      this.repeatCounts.set(key, repeats);
      if (repeats >= 3) {
        content += `\n\n[Note: you have made this exact call ${repeats} times with the same result. Change your approach.]`;
      }

      host.updateItem(itemId, {
        status: result.isError ? "error" : "done",
        endedAt: Date.now(),
        output: truncateMiddle(result.content, TOOL_OUTPUT_PREVIEW),
        ...result.ui,
        title: result.ui?.title ?? item.title,
      });
      return reply(content);
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        host.updateItem(itemId, { status: "cancelled", endedAt: Date.now() });
        throw new CancelledError();
      }
      const message = err instanceof Error ? err.message : String(err);
      host.log(`[tool:${call.name}] error: ${message}`);
      return fail(`Error: ${message}`);
    }
  }
}
