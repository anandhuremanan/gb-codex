import * as vscode from "vscode";
import { AgentConfig } from "../../config";
import { JsonSchema, LlmProvider } from "../../llm/types";
import { Todo, ToolItem } from "../transcript";

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Extra fields merged into the tool's transcript item. */
  ui?: Partial<Pick<ToolItem, "path" | "line" | "stats" | "snapshotId" | "title">>;
}

/** Per-agent state shared by that agent's tool calls. */
export interface ToolState {
  /** fsPath -> version token observed when the agent last read or wrote the file. */
  readVersions: Map<string, string>;
  /** Skills (and skill resources) already loaded in this agent's context. */
  loadedSkills?: Set<string>;
}

export interface SubagentRequest {
  type: "explore" | "general";
  description: string;
  prompt: string;
  parentItemId: string;
  signal: AbortSignal;
}

/** Session-level services available to tools. */
export interface ToolHost {
  readonly config: AgentConfig;
  setTodos(todos: Todo[]): void;
  runSubagent(request: SubagentRequest): Promise<string>;
  /** Records a file change for the turn summary and diff view; returns a snapshot id of `before`. */
  recordFileChange(uri: vscode.Uri, before: string | undefined, after: string): string;
  updateItem(id: string, patch: Partial<ToolItem>): void;
  createProvider(kind: "main" | "subagent"): LlmProvider;
}

export interface ToolContext {
  signal: AbortSignal;
  state: ToolState;
  host: ToolHost;
  itemId: string;
  /** Called by mutating tools so the agent can collect diagnostics after the step. */
  fileChanged(uri: vscode.Uri): void;
}

export type PermissionKind = "edit" | "command" | "read";

export interface PermissionRequest {
  kind: PermissionKind;
  /** What is shown to the user, e.g. the command line or "Edit src/a.ts". */
  detail: string;
  /** Workspace-relative path for file operations (after symlink resolution). */
  path?: string;
  /** Content preview shown with the approval (e.g. the replacement text of an edit). */
  preview?: string;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Read-only tools never need approval and may run in parallel. */
  readOnly: boolean;
  isConcurrencySafe?(args: A): boolean;
  permission?(args: A): PermissionRequest | undefined;
  /** Short label for the UI, e.g. a path or command. */
  title(args: A): string;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}
