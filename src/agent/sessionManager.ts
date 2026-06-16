import * as vscode from "vscode";
import { AgentSession, TaskMemory, SessionMemory, ChatMessage } from "./types";

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash.toString(36);
}

export class AgentSessionManager {
  private static instance: AgentSessionManager;
  private currentSession!: AgentSession;
  private lastRootPath = "";

  private constructor() {
    this.resetSession();
    this.setupWorkspaceListener();
  }

  public static getInstance(): AgentSessionManager {
    if (!AgentSessionManager.instance) {
      AgentSessionManager.instance = new AgentSessionManager();
    }
    return AgentSessionManager.instance;
  }

  public getSession(): AgentSession {
    // Lazily detect if the workspace changed but the event didn't fire
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
    if (this.lastRootPath !== rootPath) {
      this.lastRootPath = rootPath;
      this.resetSession();
    }
    return this.currentSession;
  }

  public resetSession(userGoal = ""): void {
    // Cancel any active running agent execution
    if (this.currentSession?.currentExecution) {
      try {
        this.currentSession.currentExecution.cancellationSource.cancel();
        this.currentSession.currentExecution.cancellationSource.dispose();
      } catch {
        // ignore
      }
    }

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
    this.lastRootPath = rootPath;

    const workspaceId = vscode.workspace.name || "default";
    const workspacePathHash = hashString(rootPath);

    this.currentSession = {
      taskMemory: {
        currentGoal: userGoal,
        activeFiles: [],
        relatedFiles: [],
        visitedFiles: [],
        visitedQueries: [],
        discoveredFacts: [],
        completedActions: [],
        createdFiles: [],
        modifiedFiles: [],
        rejectedFiles: [],
      },
      sessionMemory: {
        workspaceId,
        workspacePathHash,
        recentTasks: [],
        lastUpdated: Date.now(),
      },
      chatHistory: [],
    };

    // Load session memory from disk
    this.loadSessionMemory();
  }

  private setupWorkspaceListener() {
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
      if (this.lastRootPath !== rootPath) {
        this.lastRootPath = rootPath;
        this.resetSession();
      }
    });
  }

  private async loadSessionMemory(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return;
    }
    const sessionUri = vscode.Uri.joinPath(root, ".vscode", "bunker-session.json");
    try {
      const bytes = await vscode.workspace.fs.readFile(sessionUri);
      const content = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(content);
      
      const currentHash = hashString(root.fsPath);
      // Validate path hash to ensure isolation
      if (parsed && parsed.workspacePathHash === currentHash && Array.isArray(parsed.recentTasks)) {
        this.currentSession.sessionMemory = {
          workspaceId: parsed.workspaceId || vscode.workspace.name || "default",
          workspacePathHash: parsed.workspacePathHash,
          recentTasks: parsed.recentTasks,
          lastUpdated: parsed.lastUpdated || Date.now(),
        };
      }
    } catch {
      // Ignore if file doesn't exist or is invalid
    }
  }

  public async saveSessionMemory(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return;
    }
    const sessionUri = vscode.Uri.joinPath(root, ".vscode", "bunker-session.json");
    try {
      const vscodeFolder = vscode.Uri.joinPath(root, ".vscode");
      try {
        await vscode.workspace.fs.createDirectory(vscodeFolder);
      } catch {
        // ignore if exists
      }

      const recentTasks = this.currentSession.sessionMemory.recentTasks.slice(0, 20);
      const payload: SessionMemory = {
        workspaceId: this.currentSession.sessionMemory.workspaceId,
        workspacePathHash: this.currentSession.sessionMemory.workspacePathHash,
        recentTasks,
        lastUpdated: Date.now(),
      };

      const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
      await vscode.workspace.fs.writeFile(sessionUri, bytes);
    } catch (err) {
      console.error("Failed to save session memory", err);
    }
  }
}
