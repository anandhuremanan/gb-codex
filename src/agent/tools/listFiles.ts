import * as vscode from "vscode";
import { Tool } from "../types";

export class ListFilesTool implements Tool {
  name = "list_workspace_files";
  description = "List all file relative paths in the workspace (excluding build output, dependencies, and git metadata). Use this to discover files and inspect project structure.";

  async execute(): Promise<string[]> {
    const files = await vscode.workspace.findFiles(
      "**/*",
      "{**/node_modules/**,**/dist/**,**/build/**,**/.git/**}"
    );
    return files.map((uri) => vscode.workspace.asRelativePath(uri));
  }
}
