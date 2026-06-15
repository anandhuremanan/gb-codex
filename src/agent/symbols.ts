import { Tool } from "./types";
import { RepositoryCache } from "./cache";

export interface SymbolInfo {
  name: string;
  type: string; // 'class' | 'interface' | 'struct' | 'function' | 'route'
  filePath: string;
  line: number;
}

export class SymbolIndex {
  private index = new Map<string, SymbolInfo[]>(); // lowerName -> infos

  public indexFile(filePath: string, content: string) {
    const lines = content.split(/\r?\n/);
    const fileSymbols: SymbolInfo[] = [];

    const regexes = [
      { type: "class", regex: /(?:export\s+)?class\s+([a-zA-Z0-9_]+)/ },
      { type: "interface", regex: /(?:export\s+)?interface\s+([a-zA-Z0-9_]+)/ },
      { type: "struct", regex: /type\s+([a-zA-Z0-9_]+)\s+struct|struct\s+([a-zA-Z0-9_]+)/ },
      { type: "function", regex: /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)|func\s+([a-zA-Z0-9_]+)|def\s+([a-zA-Z0-9_]+)|fn\s+([a-zA-Z0-9_]+)/ },
      { type: "route", regex: /\.(?:get|post|put|delete|use)\(\s*['"`]([^'"`]+)/ }
    ];

    // Clear old symbols from this file
    for (const [key, list] of this.index.entries()) {
      this.index.set(key, list.filter(s => s.filePath !== filePath));
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const r of regexes) {
        const match = line.match(r.regex);
        if (match) {
          const name = match[1] || match[2] || match[3] || match[4];
          if (name && name.length > 2) {
            fileSymbols.push({
              name,
              type: r.type,
              filePath,
              line: i + 1
            });
          }
        }
      }
    }

    // Add to index
    for (const sym of fileSymbols) {
      const key = sym.name.toLowerCase();
      if (!this.index.has(key)) {
        this.index.set(key, []);
      }
      this.index.get(key)!.push(sym);
    }
  }

  public search(query: string): SymbolInfo[] {
    const results: SymbolInfo[] = [];
    const lowerQuery = query.toLowerCase();
    for (const [name, infos] of this.index.entries()) {
      if (name.includes(lowerQuery)) {
        results.push(...infos);
      }
    }
    return results;
  }
}

export class SearchSymbolsTool implements Tool {
  name = "search_symbols";
  description = "Search for classes, interfaces, structs, functions, exports, routes, and handlers in the workspace. Arguments: { \"query\": \"search string\" }";

  async execute(args: { query: string }): Promise<SymbolInfo[]> {
    if (!args || typeof args.query !== "string") {
      throw new Error("Invalid arguments: 'query' must be a string.");
    }
    const cache = RepositoryCache.getInstance();
    return cache.getSymbolIndex().search(args.query);
  }
}
