import * as vscode from "vscode";
import * as path from "path";
import { RepositoryProfile, analyzeRepository } from "./analyzer";
import { SymbolIndex } from "./tools/searchSymbols";

export class RepositoryCache {
  private static instance: RepositoryCache;

  private workspaceTree: string[] = [];
  private profile?: RepositoryProfile;
  private fileContents = new Map<string, string>();
  private symbolIndex: SymbolIndex;
  private isInitialized = false;

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
