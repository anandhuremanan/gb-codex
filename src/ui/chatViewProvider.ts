import * as vscode from "vscode";
import { SessionController } from "../session/controller";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "gbs-local-dev.chatView";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: SessionController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);

    this.controller.attachView({
      post: (message) => void view.webview.postMessage(message),
      isVisible: () => view.visible,
      reveal: () => view.show(true),
    });
    view.webview.onDidReceiveMessage((message) => this.controller.handleMessage(message));
    view.onDidDispose(() => this.controller.detachView());
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${css}" />
<title>GBS Agent</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
