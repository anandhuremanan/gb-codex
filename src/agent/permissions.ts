import * as path from "path";
import { PermissionMode } from "../config";
import { PermissionRequest } from "./tools/types";

/** Characters that let one command line run more than one program, redirect, or expand variables. */
const SHELL_META = /[;&|<>`$()\n\r^%!]/;

/**
 * Read-only commands that run without approval. Matched exactly (arguments included), because
 * prefixes such as `git diff` also accept writes like `git diff --output=<file>`.
 */
const SAFE_COMMANDS: RegExp[] = [
  // git diff/show are excluded: diff and textconv drivers from .git/config can run arbitrary programs.
  /^git status( (--short|-s|--porcelain|-sb))?$/,
  /^git log( (--oneline|-n \d{1,4}|-\d{1,4}))*$/,
  /^git branch( (--show-current|-a|--list))?$/,
  /^git rev-parse --abbrev-ref HEAD$/,
  /^pwd$/,
  /^ls( -la?)?$/,
  /^dir$/,
  /^node --version$/,
  /^npm --version$/,
];

/** Programs that can run arbitrary code or destroy data; "always allow" never generalizes them. */
const NEVER_PREFIX = new Set([
  "python", "python3", "py", "node", "deno", "bun", "npx", "pnpx", "bunx", "tsx", "ts-node",
  "bash", "sh", "zsh", "fish", "pwsh", "powershell", "cmd", "wsl", "start", "call",
  "perl", "ruby", "php", "java", "dotnet", "go", "cargo", "make",
  "rm", "del", "erase", "rmdir", "rd", "rimraf", "shred", "format", "mv", "move", "cp", "copy", "xcopy", "robocopy",
  "curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "certutil", "bitsadmin", "scp", "ssh", "ftp",
  "sudo", "su", "runas", "chmod", "chown", "icacls", "takeown", "reg", "setx", "schtasks", "sc", "net", "netsh",
]);

/** Subcommands that run something named by the next argument, so the rule must include it. */
const WRAPPER_SUBCOMMANDS = new Set(["run", "run-script", "exec", "x", "dlx", "create", "init"]);

/** Paths whose modification can run code, change tooling or CI, or redirect the agent; always need approval. */
const SENSITIVE_WRITE = [
  /(^|\/)\.vscode\//,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.github\//,
  /(^|\/)\.gitlab-ci\.yml$/,
  /(^|\/)\.husky\//,
  /(^|\/)\.devcontainer\//,
  /(^|\/)\.gbs\//,
  /(^|\/)(AGENTS|CLAUDE)\.md$/i,
  /(^|\/)package\.json$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.yarnrc(\.yml)?$/,
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)(\.gitattributes|\.gitmodules|\.pre-commit-config\.yaml|Makefile|Dockerfile|docker-compose\.ya?ml)$/,
  /(^|\/)(setup\.py|setup\.cfg|pyproject\.toml|conftest\.py|build\.gradle(\.kts)?|pom\.xml|Directory\.Build\.(props|targets))$/,
  /\.(sh|bash|zsh|ps1|psm1|bat|cmd|vbs|reg|lnk|exe|dll|csproj|vbproj|sln|targets|props|code-workspace)$/i,
  // Executed automatically by editor extensions (ESLint, Prettier, Jest, Vitest, Tailwind, ...) or build tools.
  /(^|\/)(\.?eslintrc|eslint\.config|\.?prettierrc|prettier\.config|jest\.config|vitest\.(config|workspace)|vite\.config|webpack\.config|rollup\.config|babel\.config|\.babelrc|postcss\.config|tailwind\.config|next\.config|nuxt\.config|svelte\.config|astro\.config|playwright\.config|karma\.conf|gulpfile|gruntfile|stylelint\.config|\.stylelintrc|commitlint\.config|lint-staged\.config|\.lintstagedrc|noxfile)(\.[\w-]+)*$/i,
  /(^|\/)tasks\.py$/,
  // Code that approved commands execute.
  /(^|\/)(node_modules|\.venv|venv|site-packages|vendor)\//,
];

/** Files likely to hold credentials; reading them needs approval so they are not sent to the model silently. */
const SENSITIVE_READ = [
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)(id_(rsa|dsa|ecdsa|ed25519))(\.pub)?$/,
  /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i,
  /\.(pem|key|pfx|p12|jks|keystore|kdbx|ppk)$/i,
];

/** Globs excluded from content search so credentials are not returned by grep. */
export const SECRET_FILE_GLOBS = ["!.env", "!.env.*", "!*.pem", "!*.key", "!*.pfx", "!*.p12", "!.npmrc", "!.netrc", "!.git-credentials", "!id_rsa*", "!id_ed25519*"];

const normalizeRel = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

export function isSensitiveWrite(relPath: string): boolean {
  const p = normalizeRel(relPath);
  return SENSITIVE_WRITE.some((re) => re.test(p));
}

export function isSensitiveRead(relPath: string): boolean {
  const p = normalizeRel(relPath);
  return SENSITIVE_READ.some((re) => re.test(p));
}

/** Invisible or direction-changing characters that can make displayed text differ from what runs. */
export const DECEPTIVE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

const normalizeCommand = (c: string) => c.trim().replace(/[ \t]+/g, " ");

function programName(token: string): string {
  return path.basename(token.replace(/^["']|["']$/g, "")).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

export interface CommandRule {
  type: "exact" | "prefix";
  value: string;
}

/**
 * The rule "always allow" records for a command: `npm run build`, `git commit`, `cargo test`… become
 * prefixes; interpreters, downloaders and destructive tools are only ever allowed as the exact command.
 */
export function ruleFor(command: string): CommandRule {
  const normalized = normalizeCommand(command);
  const tokens = normalized.split(" ");
  const program = programName(tokens[0] ?? "");
  if (!program || NEVER_PREFIX.has(program) || tokens[0] !== program && /[\\/]/.test(tokens[0])) {
    return { type: "exact", value: normalized };
  }
  const prefix = [program];
  for (const token of tokens.slice(1)) {
    if (token.startsWith("-") || /["'=/\\.:]/.test(token) || prefix.length === 3) {
      break;
    }
    prefix.push(token);
    if (prefix.length === 2 && !WRAPPER_SUBCOMMANDS.has(token)) {
      break;
    }
  }
  // "npm run" or "yarn dlx" alone would allow every script or package.
  if (prefix.length === 1 || WRAPPER_SUBCOMMANDS.has(prefix[prefix.length - 1])) {
    return { type: "exact", value: normalized };
  }
  return { type: "prefix", value: prefix.join(" ") };
}

function matchesRule(command: string, rule: CommandRule): boolean {
  const normalized = normalizeCommand(command);
  if (rule.type === "exact") {
    return normalized === rule.value;
  }
  const tokens = normalized.split(" ");
  const withProgram = [programName(tokens[0] ?? ""), ...tokens.slice(1)].join(" ");
  return withProgram === rule.value || withProgram.startsWith(`${rule.value} `);
}

export class PermissionPolicy {
  private readonly commandRules: CommandRule[] = [];
  private editsAllowedForSession = false;

  needsApproval(request: PermissionRequest, mode: PermissionMode): boolean {
    if (mode === "auto") {
      return false;
    }
    switch (request.kind) {
      case "read":
        return true;
      case "edit":
        if (request.path && isSensitiveWrite(request.path)) {
          return true;
        }
        return mode === "ask" && !this.editsAllowedForSession;
      case "command": {
        const command = normalizeCommand(request.detail);
        if (SHELL_META.test(command) || DECEPTIVE_CHARS.test(command)) {
          return true;
        }
        if (SAFE_COMMANDS.some((re) => re.test(command))) {
          return false;
        }
        return !this.commandRules.some((rule) => matchesRule(command, rule));
      }
    }
  }

  /** Whether "always allow" can be offered (it is not for chained, sensitive, or deceptive requests). */
  canAllowAlways(request: PermissionRequest): boolean {
    if (request.kind === "read") {
      return false;
    }
    if (request.kind === "edit") {
      return !(request.path && isSensitiveWrite(request.path));
    }
    return !SHELL_META.test(request.detail) && !DECEPTIVE_CHARS.test(request.detail);
  }

  allowAlways(request: PermissionRequest): void {
    if (!this.canAllowAlways(request)) {
      return;
    }
    if (request.kind === "edit") {
      this.editsAllowedForSession = true;
    } else if (request.kind === "command") {
      this.commandRules.push(ruleFor(request.detail));
    }
  }

  reset(): void {
    this.commandRules.length = 0;
    this.editsAllowedForSession = false;
  }

  describeAlways(request: PermissionRequest): string | undefined {
    if (!this.canAllowAlways(request)) {
      return undefined;
    }
    if (request.kind === "edit") {
      return "Allow edits this session";
    }
    const rule = ruleFor(request.detail);
    return rule.type === "exact" ? "Always allow this exact command" : `Always allow \`${rule.value} …\``;
  }
}
