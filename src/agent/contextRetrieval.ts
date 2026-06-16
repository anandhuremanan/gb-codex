import * as path from "path";
import { RepositoryCache } from "./cache";
import { AgentSessionManager } from "./sessionManager";

export function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    "the", "and", "a", "an", "or", "in", "on", "to", "for", "with", "is", "are", 
    "of", "at", "this", "that", "it", "file", "page", "component", "routing", 
    "add", "create", "delete", "edit", "update", "how", "why", "where", "what",
    "can", "you", "me", "my", "your", "we", "our", "us", "i", "new", "list", "route"
  ]);
  
  return text
    .toLowerCase()
    .split(/[^a-zA-Z0-9_-]/)
    .map(w => w.trim())
    .filter(w => w.length > 2 && !stopwords.has(w));
}

export class ContextRetrievalService {
  private static MAX_RELEVANT_FILES = 10;
  private static MAX_RELATED_FILES = 10;
  private static MAX_SYMBOLS = 20;

  public static async getRelevantFiles(userRequest: string): Promise<string[]> {
    const keywords = extractKeywords(userRequest);
    if (keywords.length === 0) {
      return [];
    }

    const cache = RepositoryCache.getInstance();
    const tree = cache.getWorkspaceTree();
    const session = AgentSessionManager.getInstance().getSession();
    const taskMemory = session.taskMemory;

    const scoredFiles: { file: string; score: number }[] = [];
    const recentTasks = session.sessionMemory.recentTasks || [];

    for (const file of tree) {
      const fileLower = file.toLowerCase();
      const basename = fileLower.split(/[/\\]/).pop() || "";
      let score = 0;

      // 1. Keyword match in filename or path
      for (const kw of keywords) {
        if (basename.includes(kw)) {
          score += 10;
        } else if (fileLower.includes(kw)) {
          score += 3;
        }
      }

      if (score > 0) {
        // 2. Multi-factor ranking:
        // Recently modified in this execution
        if (taskMemory.modifiedFiles.includes(file)) {
          score += 15;
        }
        // Recently visited in this execution
        if (taskMemory.visitedFiles.includes(file)) {
          score += 8;
        }
        // Referenced in session memory
        const referencedInSession = recentTasks.some(t => 
          t.modifiedFiles.includes(file) || t.createdFiles.includes(file)
        );
        if (referencedInSession) {
          score += 5;
        }
        
        scoredFiles.push({ file, score });
      }
    }

    scoredFiles.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    return scoredFiles.slice(0, this.MAX_RELEVANT_FILES).map(x => x.file);
  }

  public static async getRelatedFiles(filePath: string): Promise<{
    siblingFiles: string[];
    childRoutes: string[];
    nearbyComponents: string[];
  }> {
    const cache = RepositoryCache.getInstance();
    const tree = cache.getWorkspaceTree();

    const normalizedPath = filePath.replace(/\\/g, "/");
    const parentDir = normalizedPath.includes("/") 
      ? normalizedPath.substring(0, normalizedPath.lastIndexOf("/"))
      : "";

    const siblingFiles: string[] = [];
    const childRoutes: string[] = [];
    const nearbyComponents: string[] = [];

    const grandparentDir = parentDir.includes("/")
      ? parentDir.substring(0, parentDir.lastIndexOf("/"))
      : "";

    for (const f of tree) {
      const fNormalized = f.replace(/\\/g, "/");
      if (fNormalized === normalizedPath) {
        continue;
      }

      const fParent = fNormalized.includes("/") 
        ? fNormalized.substring(0, fNormalized.lastIndexOf("/"))
        : "";

      // 1. Same Directory Files
      if (fParent === parentDir) {
        siblingFiles.push(f);
      }
      // 2. Child Routes
      else if (parentDir && fNormalized.startsWith(parentDir + "/")) {
        const lower = fNormalized.toLowerCase();
        if (lower.includes("page") || lower.includes("route") || lower.includes("app")) {
          childRoutes.push(f);
        }
      }
      // 3. Nearby Components
      else if (grandparentDir && fNormalized.startsWith(grandparentDir + "/")) {
        const lower = fNormalized.toLowerCase();
        if (lower.includes("component")) {
          nearbyComponents.push(f);
        }
      }
    }

    return {
      siblingFiles: siblingFiles.slice(0, 10),
      childRoutes: childRoutes.slice(0, 10),
      nearbyComponents: nearbyComponents.slice(0, 10)
    };
  }

  public static async getRelevantSymbols(userRequest: string): Promise<any[]> {
    const keywords = extractKeywords(userRequest);
    if (keywords.length === 0) {
      return [];
    }

    const cache = RepositoryCache.getInstance();
    const tree = cache.getWorkspaceTree();

    const codeExtensions = new Set([
      ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".cs", 
      ".html", ".css", ".json", ".md", ".sh", ".yaml", ".yml"
    ]);
    const loadPromises = tree.map(async (filePath) => {
      const lower = filePath.toLowerCase();
      const ext = path.extname(filePath).toLowerCase();
      if (!codeExtensions.has(ext)) {
        return;
      }
      const basename = lower.split(/[/\\]/).pop() || "";
      const matchesKeyword = keywords.some(kw => basename.includes(kw));
      if (matchesKeyword) {
        try {
          await cache.getFileContent(filePath);
        } catch {
          // ignore read errors
        }
      }
    });
    await Promise.all(loadPromises);

    const symbolIndex = cache.getSymbolIndex();
    const matches: any[] = [];
    const seenSymbols = new Set<string>();

    for (const kw of keywords) {
      const symbolMatches = symbolIndex.search(kw);
      for (const sym of symbolMatches) {
        const key = `${sym.filePath}:${sym.name}`;
        if (!seenSymbols.has(key)) {
          seenSymbols.add(key);
          matches.push({
            file: sym.filePath,
            symbol: sym.name,
            type: sym.type,
            line: sym.line
          });
        }
      }
    }

    return matches.slice(0, this.MAX_SYMBOLS);
  }

  public static async getRelevantPriorTasks(userRequest: string): Promise<any[]> {
    const keywords = extractKeywords(userRequest);
    const session = AgentSessionManager.getInstance().getSession();
    const recentTasks = session.sessionMemory.recentTasks || [];

    if (keywords.length === 0) {
      return [];
    }

    const relatedTasks: any[] = [];

    for (const task of recentTasks) {
      let hasOverlap = false;

      const goalLower = task.goal.toLowerCase();
      const summaryLower = task.summary.toLowerCase();
      for (const kw of keywords) {
        if (goalLower.includes(kw) || summaryLower.includes(kw)) {
          hasOverlap = true;
          break;
        }
      }

      if (!hasOverlap) {
        const taskFiles = [...task.modifiedFiles, ...task.createdFiles].map(f => f.toLowerCase());
        const relevantFiles = await this.getRelevantFiles(userRequest);
        const relevantFilesLower = relevantFiles.map(f => f.toLowerCase());
        for (const rf of relevantFilesLower) {
          if (taskFiles.some(tf => tf.includes(rf) || rf.includes(tf))) {
            hasOverlap = true;
            break;
          }
        }
      }

      if (!hasOverlap && task.symbolsTouched) {
        for (const kw of keywords) {
          if (task.symbolsTouched.some(sym => sym.toLowerCase().includes(kw))) {
            hasOverlap = true;
            break;
          }
        }
      }

      if (hasOverlap) {
        relatedTasks.push({
          goal: task.goal,
          summary: task.summary,
          modifiedFiles: task.modifiedFiles,
          createdFiles: task.createdFiles,
          symbolsTouched: task.symbolsTouched || [],
          timestamp: task.timestamp
        });
      }
    }

    return relatedTasks.slice(0, 3);
  }

  public static async buildWorkingContext(userRequest: string): Promise<{
    relevantFiles: string[];
    relatedFiles: string[];
    relevantSymbols: string[];
    recentModifications: any[];
  }> {
    const relevantFiles = await this.getRelevantFiles(userRequest);

    const session = AgentSessionManager.getInstance().getSession();
    const activeFiles = session.taskMemory.activeFiles || [];
    let relatedFiles: string[] = [];

    const fileToQuery = activeFiles[0] || relevantFiles[0];
    if (fileToQuery) {
      const rel = await this.getRelatedFiles(fileToQuery);
      relatedFiles = Array.from(new Set([
        ...rel.siblingFiles,
        ...rel.childRoutes,
        ...rel.nearbyComponents
      ])).slice(0, this.MAX_RELATED_FILES);
    }

    const symbols = await this.getRelevantSymbols(userRequest);
    const relevantPriorTasks = await this.getRelevantPriorTasks(userRequest);

    return {
      relevantFiles,
      relatedFiles,
      relevantSymbols: symbols.map(s => `${s.symbol} (${s.type}) in ${s.file}:${s.line}`),
      recentModifications: relevantPriorTasks
    };
  }
}
