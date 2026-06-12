import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView";

export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewId,
      provider,
    ),
  );
}

export function deactivate() {}
