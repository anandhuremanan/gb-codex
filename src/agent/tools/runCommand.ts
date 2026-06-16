import * as vscode from "vscode";
import { exec } from "child_process";
import { Tool } from "../types";

export class RunTerminalCommandTool implements Tool {
  name = "run_terminal_command";
  description = "Run a shell command in the workspace root. Arguments: { \"command\": \"command string\" }";
  schema = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The terminal command to execute in the workspace root"
      }
    },
    required: ["command"]
  };

  async execute(args: { command: string }): Promise<{ stdout: string; stderr: string; code: number }> {
    if (!args || typeof args.command !== "string") {
      throw new Error("Invalid arguments: 'command' must be a string.");
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      throw new Error("No workspace folder open.");
    }
    return new Promise((resolve) => {
      exec(args.command, { cwd: root }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout,
          stderr: stderr,
          code: error ? (error.code ?? 1) : 0
        });
      });
    });
  }
}
