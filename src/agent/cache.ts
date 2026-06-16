import * as vscode from "vscode";
import * as path from "path";
import { RepositoryProfile, analyzeRepository } from "./analyzer";
import { SymbolIndex } from "./tools/searchSymbols";

export interface WorkspaceSnapshot {
  topLevelFolders: string[];
  importantRoutes: string[];
  importantEntrypoints: string[];
  importantConfigFiles: string[];
}

export class RepositoryCache {
  private static instance: RepositoryCache;

  private workspaceTree: string[] = [];
  private profile?: RepositoryProfile;
  private fileContents = new Map<string, string>();
  private symbolIndex: SymbolIndex;
  private isInitialized = false;
  private workspaceSnapshot?: WorkspaceSnapshot;

  private constructor() {
    this.symbolIndex = new SymbolIndex();
    this.setupListeners();
  }

  public static getInstance(): RepositoryCache {
    if (!RepositoryCache.instance) {
      RepositoryCache.instance = new RepositoryCache();
    }
    return RepositoryCache.instance;
  }

  private reindexTimeout?: NodeJS.Timeout;

  public async initialize(force = false): Promise<void> {
    if (this.isInitialized && !force) {
      return;
    }

    // 1. Scan workspace structure
    const files = await vscode.workspace.findFiles(
      "**/*",
      "{**/node_modules/**,**/dist/**,**/build/**,**/.git/**}"
    );
    this.workspaceTree = files.map(f => vscode.workspace.asRelativePath(f));

    // 2. Perform Repository Analysis
    this.profile = await analyzeRepository();

    this.isInitialized = true;
  }

  public generateWorkspaceSnapshot(): WorkspaceSnapshot {
    const topLevelFolders = new Set<string>();
    const importantRoutes: string[] = [];
    const importantEntrypoints: string[] = [];
    const importantConfigFiles: string[] = [];

    const configNames = new Set([
      "package.json", "tsconfig.json", "webpack.config.js", "eslint.config.mjs", 
      "next.config.js", "vite.config.ts", "vite.config.js", "cargo.toml", 
      "go.mod", "pyproject.toml", "requirements.txt", "gemfile"
    ]);

    for (const filePath of this.workspaceTree) {
      const parts = filePath.replace(/\\/g, "/").split("/");
      if (parts.length > 1) {
        topLevelFolders.add(parts[0]);
      }

      const lower = filePath.toLowerCase();
      const basename = parts[parts.length - 1];
      const basenameLower = basename.toLowerCase();

      // Major configuration files (exclude large files/lockfiles)
      if (configNames.has(basenameLower)) {
        importantConfigFiles.push(filePath);
      }

      // Important entrypoints
      if (
        basenameLower === "index.ts" ||
        basenameLower === "index.js" ||
        basenameLower === "main.ts" ||
        basenameLower === "main.js" ||
        basenameLower === "app.ts" ||
        basenameLower === "app.tsx" ||
        basenameLower === "server.ts" ||
        basenameLower === "server.js"
      ) {
        importantEntrypoints.push(filePath);
      }

      // Important routes (routes/pages, but keep it compact)
      if (lower.includes("route") || lower.includes("page") || lower.includes("app/")) {
        importantRoutes.push(filePath);
      }
    }

    return {
      topLevelFolders: Array.from(topLevelFolders),
      importantRoutes: importantRoutes.slice(0, 10),
      importantEntrypoints: importantEntrypoints.slice(0, 5),
      importantConfigFiles: importantConfigFiles.slice(0, 5)
    };
  }

  public getWorkspaceSnapshot(): WorkspaceSnapshot {
    if (!this.workspaceSnapshot) {
      this.workspaceSnapshot = this.generateWorkspaceSnapshot();
    }
    return this.workspaceSnapshot;
  }

  public getCompactWorkspaceSnapshot(): string {
    const snap = this.getWorkspaceSnapshot();
    return `Workspace Snapshot:
Top-Level Folders: ${snap.topLevelFolders.join(", ") || "None"}
Important Entrypoints: ${snap.importantEntrypoints.join(", ") || "None"}
Important Configs: ${snap.importantConfigFiles.join(", ") || "None"}
Important Routes: ${snap.importantRoutes.join(", ") || "None"}`;
  }

  public getWorkspaceTree(): string[] {
    return this.workspaceTree;
  }

  public getProfile(): RepositoryProfile {
    return this.profile || { language: "Unknown" };
  }

  public getCachedFileContents(): Map<string, string> {
    return this.fileContents;
  }

  public async getFileContent(filePath: string): Promise<string> {
    const cached = this.fileContents.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    // Lazily load and cache
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (root) {
      const uri = vscode.Uri.joinPath(root, filePath);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = new TextDecoder("utf8").decode(bytes);
        this.fileContents.set(filePath, content);
        this.symbolIndex.indexFile(filePath, content);
        return content;
      } catch (err) {
        throw new Error(`Failed to read file ${filePath}: ${err}`);
      }
    }
    throw new Error(`Workspace root not found for ${filePath}`);
  }

  public setFileContent(filePath: string, content: string) {
    this.fileContents.set(filePath, content);
    this.symbolIndex.indexFile(filePath, content);
  }

  public getSymbolIndex(): SymbolIndex {
    return this.symbolIndex;
  }

  public scheduleReindex(): void {
    if (this.reindexTimeout) {
      clearTimeout(this.reindexTimeout);
    }
    this.reindexTimeout = setTimeout(async () => {
      try {
        const files = await vscode.workspace.findFiles(
          "**/*",
          "{**/node_modules/**,**/dist/**,**/build/**,**/.git/**}"
        );
        this.workspaceTree = files.map(f => vscode.workspace.asRelativePath(f));
        this.profile = await analyzeRepository();
      } catch {
        // ignore
      }
    }, 2000);
  }

  private setupListeners() {
    // 1. File saves
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const relPath = vscode.workspace.asRelativePath(doc.uri);
      if (
        relPath.includes("node_modules") ||
        relPath.includes("dist") ||
        relPath.includes("build") ||
        relPath.includes(".git")
      ) {
        return;
      }
      const text = doc.getText();
      this.fileContents.set(relPath, text);
      this.symbolIndex.indexFile(relPath, text);
    });

    // 2. Created files
    vscode.workspace.onDidCreateFiles((e) => {
      for (const uri of e.files) {
        const relPath = vscode.workspace.asRelativePath(uri);
        if (
          relPath.includes("node_modules") ||
          relPath.includes("dist") ||
          relPath.includes("build") ||
          relPath.includes(".git")
        ) {
          continue;
        }
        if (!this.workspaceTree.includes(relPath)) {
          this.workspaceTree.push(relPath);
        }
      }
      this.scheduleReindex();
    });

    // 3. Deleted files
    vscode.workspace.onDidDeleteFiles((e) => {
      for (const uri of e.files) {
        const relPath = vscode.workspace.asRelativePath(uri);
        this.workspaceTree = this.workspaceTree.filter(p => p !== relPath);
        this.fileContents.delete(relPath);
      }
      this.scheduleReindex();
    });
  }
}
