import * as vscode from "vscode";
import { Tool } from "../types";

export class CreateFileTool implements Tool {
  name = "create_file";
  description = "Create a new file in the workspace. Arguments: { \"path\": \"relative/path/to/file\", \"content\": \"initial content\" }";

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
        return { success: true, message: `File ${args.path} already existed. Overwrote content.` };
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
        return { success: true, message: `Successfully created file ${args.path}.` };
      } else {
        return { success: false, message: `Failed to create file ${args.path}.` };
      }
    }
  }
}
