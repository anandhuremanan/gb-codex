import * as vscode from "vscode";
import { LlmMessage } from "../llm/types";
import { Todo, TranscriptItem } from "../agent/transcript";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt size of the most recent main-agent request (context fill). */
  lastInputTokens: number;
}

export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: LlmMessage[];
  items: TranscriptItem[];
  todos: Todo[];
  usage: SessionUsage;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
}

const INDEX_KEY = "gbsAgent.sessions";
const ACTIVE_KEY = "gbsAgent.activeSession";
const sessionKey = (id: string) => `gbsAgent.session.${id}`;
const MAX_SESSIONS = 25;

/** Chat sessions persisted per workspace (VS Code workspaceState — nothing is written into the repo). */
export class SessionStore {
  constructor(private readonly memento: vscode.Memento) {}

  list(): SessionMeta[] {
    return this.memento.get<SessionMeta[]>(INDEX_KEY, []);
  }

  load(id: string): StoredSession | undefined {
    return this.memento.get<StoredSession>(sessionKey(id));
  }

  get activeId(): string | undefined {
    return this.memento.get<string>(ACTIVE_KEY);
  }

  async setActive(id: string): Promise<void> {
    await this.memento.update(ACTIVE_KEY, id);
  }

  async save(session: StoredSession): Promise<void> {
    if (session.items.length === 0) {
      return;
    }
    await this.memento.update(sessionKey(session.id), session);
    const index = this.list().filter((s) => s.id !== session.id);
    index.unshift({ id: session.id, title: session.title || "New chat", updatedAt: session.updatedAt });
    for (const stale of index.splice(MAX_SESSIONS)) {
      await this.memento.update(sessionKey(stale.id), undefined);
    }
    await this.memento.update(INDEX_KEY, index);
  }

  async delete(id: string): Promise<void> {
    await this.memento.update(sessionKey(id), undefined);
    await this.memento.update(
      INDEX_KEY,
      this.list().filter((s) => s.id !== id),
    );
  }
}
