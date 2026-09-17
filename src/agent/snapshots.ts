import * as vscode from "vscode";
import { newId } from "../llm/types";

const MAX_SNAPSHOTS = 200;

/** In-memory "before" contents of edited files, served to VS Code's diff editor. */
export class SnapshotStore implements vscode.TextDocumentContentProvider {
  static readonly scheme = "gbs-agent-snapshot";
  private readonly snapshots = new Map<string, string>();

  put(content: string): string {
    const id = newId("snap");
    this.snapshots.set(id, content);
    if (this.snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest) {
        this.snapshots.delete(oldest);
      }
    }
    return id;
  }

  has(id: string): boolean {
    return this.snapshots.has(id);
  }

  uri(id: string, relPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SnapshotStore.scheme, path: `/${relPath}`, query: id });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.snapshots.get(uri.query) ?? "";
  }
}
