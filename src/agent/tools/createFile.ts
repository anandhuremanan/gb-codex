import * as vscode from "vscode";
import { Tool } from "../types";
import { RepositoryCache } from "../cache";

export class CreateFileTool implements Tool {
  name = "create_file";
  description = "Create a new file in the workspace. For large files, you can pass an empty string \"\" for content to create it first, then use patch_file to write its content in smaller steps. Arguments: { \"path\": \"relative/path/to/file\", \"content\": \"initial content\" }";
  schema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the new file to create"
      },
      content: {
        type: "string",
        description: "Initial content of the file. Use empty string for large files, and write them in steps via patch_file."
      }
    },
    required: ["path", "content"]
  };

  async execute(args: { path: string; content: string }): Promise<{ success: boolean; message: string }> {
    if (!args || typeof args.path !== "string" || typeof args.content !== "string") {
      throw new Error("Invalid arguments: 'path' and 'content' must be strings.");
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      throw new Error("No workspace folder open.");
    }
    const uri = vscode.Uri.joinPath(root, args.path);
    
    try {
      await vscode.workspace.fs.stat(uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, fullRange, args.content);
      const applied = await vscode.workspace.applyEdit(edit);
      if (applied) {
        await doc.save();
        RepositoryCache.getInstance().setFileContent(args.path, args.content);
        return {
          success: true,
          message: `SUCCESS\nTool: create_file\nFile: ${args.path}\nOperation: Updated\nCharacters Written: ${args.content.length}`
        };
      }
      throw new Error(`File already exists and failed to overwrite.`);
    } catch {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { overwrite: true, ignoreIfExists: true });
      edit.insert(uri, new vscode.Position(0, 0), args.content);
      const applied = await vscode.workspace.applyEdit(edit);
      if (applied) {
        const doc = await vscode.workspace.openTextDocument(uri);
        await doc.save();
        RepositoryCache.getInstance().setFileContent(args.path, args.content);
        return {
          success: true,
          message: `SUCCESS\nTool: create_file\nFile: ${args.path}\nOperation: Created\nCharacters Written: ${args.content.length}`
        };
      } else {
        return { success: false, message: `Failed to create file ${args.path}.` };
      }
    }
  }
}

