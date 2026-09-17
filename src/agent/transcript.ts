/** Transcript items rendered by the chat webview. The host owns them; the webview only displays. */

export type ToolStatus = "running" | "awaiting" | "done" | "error" | "denied" | "cancelled";

export interface UserItem {
  kind: "user";
  id: string;
  text: string;
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  text: string;
  thinking?: string;
  streaming: boolean;
}

export interface ToolItem {
  kind: "tool";
  id: string;
  parentId?: string;
  name: string;
  title: string;
  status: ToolStatus;
  startedAt: number;
  endedAt?: number;
  /** Result preview shown when expanded. */
  output?: string;
  /** Live tail for long-running commands. */
  live?: string;
  path?: string;
  line?: number;
  stats?: { added: number; removed: number };
  snapshotId?: string;
  approval?: { kind: "edit" | "command" | "read"; detail: string; preview?: string; alwaysLabel?: string };
  subagent?: { type: string; toolUses: number; activity?: string };
}

export interface NoticeItem {
  kind: "notice";
  id: string;
  level: "info" | "warning" | "error";
  text: string;
}

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  snapshotId?: string;
  created: boolean;
}

export interface TurnSummaryItem {
  kind: "summary";
  id: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  files: ChangedFile[];
}

export type TranscriptItem = UserItem | AssistantItem | ToolItem | NoticeItem | TurnSummaryItem;

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}
