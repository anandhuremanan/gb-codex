import * as vscode from "vscode";
import { Tool } from "../types";

export class ReadFileTool implements Tool {
  name = "read_file";
  description = "Read the content of a file in the workspace. Arguments: { \"path\": \"relative/path/to/file\" }";

  async execute(args: { path: string }): Promise<string> {
    if (!args || typeof args.path !== "string") {
      throw new Error("Invalid arguments: 'path' must be a string.");
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      throw new Error("No workspace folder open.");
    }
    const uri = vscode.Uri.joinPath(root, args.path);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder("utf8").decode(bytes);
  }
}
