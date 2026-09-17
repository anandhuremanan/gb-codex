import { ChildProcess, spawn } from "child_process";
import { Tool } from "./types";
import { getRoot, resolvePath } from "../workspace";

interface Args {
  command: string;
  cwd?: string;
  timeout_seconds?: number;
  description?: string;
}

const HEAD_CHARS = 6000;
const TAIL_CHARS = 14000;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** Keeps the beginning and end of long output without holding everything in memory. */
class OutputBuffer {
  private head = "";
  private tail = "";
  private dropped = 0;

  append(text: string): void {
    if (this.head.length < HEAD_CHARS) {
      const room = HEAD_CHARS - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) {
      return;
    }
    this.tail += text;
    if (this.tail.length > TAIL_CHARS * 2) {
      const cut = this.tail.length - TAIL_CHARS;
      this.dropped += cut;
      this.tail = this.tail.slice(cut);
    }
  }

  lastChars(n: number): string {
    const all = this.head + this.tail;
    return all.slice(-n);
  }

  toString(): string {
    let tail = this.tail;
    let dropped = this.dropped;
    if (tail.length > TAIL_CHARS) {
      dropped += tail.length - TAIL_CHARS;
      tail = tail.slice(-TAIL_CHARS);
    }
    return dropped > 0 ? `${this.head}\n\n[... ${dropped} characters of output omitted ...]\n\n${tail}` : this.head + tail;
  }
}

// Matches whole name segments (HF_TOKEN, AWS_SECRET_ACCESS_KEY, OPENAI_API_KEY) but not SSH_AUTH_SOCK or DBUS_SESSION_BUS_ADDRESS.
const SECRET_ENV = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY|KEY|CREDENTIALS?|COOKIE|CONNECTION_?STRING|CONNSTR|PAT)(_|$)/i;
const HOST_ENV = /^(VSCODE_|ELECTRON_|CHROME_CRASHPAD)/i;

/**
 * Environment for agent-run commands: the user's environment minus credentials and editor-internal
 * variables, so a command (or its output sent to the model) can't leak them.
 */
export function commandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !SECRET_ENV.test(name) && !HOST_ENV.test(name)) {
      env[name] = value;
    }
  }
  return {
    ...env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    // cmd.exe otherwise runs e.g. git.bat from the workspace folder before the real git on PATH.
    NoDefaultCurrentDirectoryInExePath: "1",
    // Overrides .git/config (git >= 2.31): a repository's fsmonitor hook would otherwise run on git status.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
  };
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => undefined);
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export function shellDescription(configured: string): string {
  if (configured) {
    return configured;
  }
  return process.platform === "win32" ? "cmd.exe" : process.env.SHELL || "/bin/sh";
}

export const runCommandTool: Tool<Args> = {
  name: "run_command",
  description:
    "Run a shell command in the workspace (non-interactive; stdin is closed). Use it for builds, tests, linters, git, and package managers — not for reading or searching files (use read_file/grep/glob). Output is truncated to the beginning and end when long. Avoid commands that never exit (dev servers, watch mode). Default timeout 120s.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to execute." },
      description: { type: "string", description: "Short description of what the command does (5-10 words)." },
      cwd: { type: "string", description: "Working directory relative to the workspace root (default: root)." },
      timeout_seconds: { type: "number", description: "Timeout in seconds (max 600)." },
    },
    required: ["command"],
  },
  readOnly: false,
  permission: (a) => ({ kind: "command", detail: a.command }),
  title: (a) => a.command,
  async execute(args, ctx) {
    if (typeof args.command !== "string" || !args.command.trim()) {
      return { content: "command must be a non-empty string.", isError: true };
    }
    const cwd = args.cwd ? resolvePath(args.cwd).fsPath : getRoot().fsPath;
    const timeoutSeconds = Math.min(600, Math.max(1, args.timeout_seconds ?? ctx.host.config.commandTimeoutSeconds));
    const shell = ctx.host.config.shell || true;

    return new Promise((resolve) => {
      const output = new OutputBuffer();
      const startedAt = Date.now();
      let timedOut = false;
      let settled = false;

      const child = spawn(args.command, {
        cwd,
        shell,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: commandEnvironment(),
      });

      let liveTimer: NodeJS.Timeout | undefined;
      const pushLive = () => {
        liveTimer = undefined;
        ctx.host.updateItem(ctx.itemId, { live: output.lastChars(1200) });
      };
      const onData = (data: Buffer) => {
        output.append(data.toString("utf8").replace(ANSI, ""));
        if (!liveTimer) {
          liveTimer = setTimeout(pushLive, 250);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutSeconds * 1000);
      const onAbort = () => killTree(child);
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const finish = (code: number | null, error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearTimeout(liveTimer);
        ctx.signal.removeEventListener("abort", onAbort);
        ctx.host.updateItem(ctx.itemId, { live: undefined });
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        const text = output.toString().trim();
        if (error) {
          resolve({ content: `Failed to start command: ${error.message}`, isError: true });
          return;
        }
        let header = `Exit code: ${code ?? "killed"} (${seconds}s)`;
        if (timedOut) {
          header = `Command timed out after ${timeoutSeconds}s and was killed.`;
        } else if (ctx.signal.aborted) {
          header = "Command was cancelled by the user.";
        }
        resolve({ content: `${header}\n${text || "(no output)"}`, isError: timedOut || (code !== 0 && code !== null) });
      };
      child.on("error", (err) => finish(null, err));
      child.on("close", (code) => finish(code));
    });
  },
};
