import * as vscode from "vscode";
import { Tool } from "../types";

export class SearchWorkspaceTool implements Tool {
  name = "search_workspace";
  description = "Search for a query string in the workspace files. Arguments: { \"query\": \"search query\" }";

  async execute(args: { query: string }): Promise<{ path: string; line: number; preview: string }[]> {
    if (!args || typeof args.query !== "string") {
      throw new Error("Invalid arguments: 'query' must be a string.");
    }

    const query = args.query.toLowerCase();
    const files = await vscode.workspace.findFiles(
      "**/*",
      "{**/node_modules/**,**/dist/**,**/build/**,**/.git/**}"
    );

    const matches: { path: string; line: number; preview: string }[] = [];

    for (const file of files) {
      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        const content = new TextDecoder("utf8").decode(bytes);
        if (content.toLowerCase().includes(query)) {
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(query)) {
              matches.push({
                path: vscode.workspace.asRelativePath(file),
                line: i + 1,
                preview: lines[i].trim()
              });
              // Limit results to prevent overloading
              if (matches.length >= 100) {
                return matches;
              }
            }
          }
        }
      } catch {
        // Skip files that can't be read (e.g. binary or special files)
      }
    }

    return matches;
  }
}
