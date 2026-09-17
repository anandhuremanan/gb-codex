import * as vscode from "vscode";
import { promptForApiKey, readConfig } from "./config";
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
    vscode.commands.registerCommand("gbsAgent.setApiKey", () => promptForApiKey(context.secrets, readConfig().openaiBaseUrl)),
    vscode.commands.registerCommand("gbsAgent.clearHistory", async () => {
      const clear = "Delete all chats";
      const choice = await vscode.window.showWarningMessage(
        "Delete all GBS Agent chat history for this workspace?",
        { modal: true, detail: "Stored conversations may include file contents the agent read." },
        clear,
      );
      if (choice === clear) {
        await controller.clearHistory();
      }
    }),
    vscode.commands.registerCommand("gbsAgent.showLogs", () => output.show()),
  );
}

export function deactivate() {}
