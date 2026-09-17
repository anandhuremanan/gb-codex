import * as vscode from "vscode";
import { promptForApiKey } from "./config";
import { SnapshotStore } from "./agent/snapshots";
import { SessionController } from "./session/controller";
import { SessionStore } from "./session/store";
import { ChatViewProvider } from "./ui/chatViewProvider";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("GBS Agent");
  const snapshots = new SnapshotStore();
  const controller = new SessionController(context, new SessionStore(context.workspaceState), snapshots, output);
  const provider = new ChatViewProvider(context.extensionUri, controller);

  context.subscriptions.push(
    output,
    controller,
    vscode.workspace.registerTextDocumentContentProvider(SnapshotStore.scheme, snapshots),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("gbsAgent.newChat", () => controller.newChat()),
    vscode.commands.registerCommand("gbsAgent.stop", () => controller.stop()),
    vscode.commands.registerCommand("gbsAgent.setApiKey", () => promptForApiKey(context.secrets)),
    vscode.commands.registerCommand("gbsAgent.showLogs", () => output.show()),
  );
}

export function deactivate() {}
