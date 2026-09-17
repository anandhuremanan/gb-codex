import * as vscode from "vscode";

export type ProviderKind = "ollama" | "openai";
export type PermissionMode = "ask" | "acceptEdits" | "auto";

export interface AgentConfig {
  provider: ProviderKind;
  model: string;
  subagentModel: string;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  maxSteps: number;
  permissionMode: PermissionMode;
  commandTimeoutSeconds: number;
  maxToolOutputChars: number;
  shell: string;
}

const SECTION = "gbsAgent";

/**
 * Settings that decide where code and keys are sent, what runs, and whether the user is asked.
 * They are only read from user (or machine) settings: a repository's .vscode/settings.json
 * must never be able to change them.
 */
export const PROTECTED_SETTINGS = new Set([
  "provider",
  "model",
  "subagentModel",
  "ollama.baseUrl",
  "openai.baseUrl",
  "openai.apiKey",
  "huggingfaceToken",
  "permissionMode",
  "shell",
]);

function setting<T>(key: string, fallback: T): T {
  const c = vscode.workspace.getConfiguration(SECTION);
  if (!PROTECTED_SETTINGS.has(key)) {
    return c.get<T>(key, fallback);
  }
  const inspected = c.inspect<T>(key);
  return (inspected?.globalValue ?? inspected?.defaultValue ?? fallback) as T;
}

export function readConfig(): AgentConfig {
  const mode = setting<string>("permissionMode", "acceptEdits");
  return {
    provider: setting<string>("provider", "ollama") === "openai" ? "openai" : "ollama",
    model: setting<string>("model", "deepseek-v4-flash:cloud").trim(),
    subagentModel: setting<string>("subagentModel", "").trim(),
    ollamaBaseUrl: setting<string>("ollama.baseUrl", "http://localhost:11434"),
    openaiBaseUrl: setting<string>("openai.baseUrl", "https://router.huggingface.co/v1"),
    contextWindow: Math.max(4096, setting<number>("contextWindow", 32768)),
    maxOutputTokens: Math.max(512, setting<number>("maxOutputTokens", 8192)),
    temperature: setting<number>("temperature", 0.2),
    maxSteps: Math.max(1, setting<number>("maxSteps", 60)),
    permissionMode: mode === "ask" || mode === "auto" ? mode : "acceptEdits",
    commandTimeoutSeconds: Math.max(5, setting<number>("commandTimeoutSeconds", 120)),
    maxToolOutputChars: Math.max(2000, setting<number>("maxToolOutputChars", 20000)),
    shell: setting<string>("shell", "").trim(),
  };
}

/** Updates a setting. Protected settings always go to user settings; others follow where they are defined. */
export async function updateConfig(key: string, value: unknown): Promise<void> {
  const c = vscode.workspace.getConfiguration(SECTION);
  const inspected = c.inspect(key);
  const target =
    !PROTECTED_SETTINGS.has(key) && inspected?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await c.update(key, value, target);
}

// ─── API keys ────────────────────────────────────────────────────────────────

const SECRET_KEY = "gbsAgent.apiKey";

interface StoredKey {
  key: string;
  /** Origin (scheme://host:port) the user approved this key for. */
  origin?: string;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

async function readStoredKey(secrets: vscode.SecretStorage): Promise<StoredKey | undefined> {
  const raw = await secrets.get(SECRET_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.key === "string") {
      return parsed as StoredKey;
    }
  } catch {
    // Keys saved by older versions are plain strings with no bound origin.
  }
  return { key: raw };
}

/**
 * Returns the API key for `baseUrl`. A key from secret storage is only sent to the origin it was
 * saved for; any other origin needs explicit confirmation (or is refused when `interactive` is false).
 */
export async function getApiKey(
  secrets: vscode.SecretStorage,
  baseUrl: string,
  interactive: boolean,
): Promise<string | undefined> {
  const origin = originOf(baseUrl);
  const stored = await readStoredKey(secrets);
  if (stored) {
    if (stored.origin === origin) {
      return stored.key;
    }
    if (!interactive) {
      return undefined;
    }
    const send = "Send key";
    const replace = "Enter a different key";
    const choice = await vscode.window.showWarningMessage(
      `Send your saved API key to ${origin}?`,
      {
        modal: true,
        detail: `The key was saved for ${stored.origin ?? "an unspecified endpoint"}. Only continue if you trust ${origin}.`,
      },
      send,
      replace,
    );
    if (choice === send) {
      await secrets.store(SECRET_KEY, JSON.stringify({ key: stored.key, origin }));
      return stored.key;
    }
    return choice === replace ? promptForApiKey(secrets, baseUrl) : undefined;
  }

  const fromUserSettings = setting<string>("openai.apiKey", "") || setting<string>("huggingfaceToken", "");
  const key = fromUserSettings || process.env.HF_TOKEN || process.env.OPENAI_API_KEY;
  if (key || !interactive || isLoopbackUrl(baseUrl)) {
    return key || undefined;
  }
  return promptForApiKey(secrets, baseUrl);
}

export async function promptForApiKey(secrets: vscode.SecretStorage, baseUrl: string): Promise<string | undefined> {
  const origin = originOf(baseUrl);
  const value = await vscode.window.showInputBox({
    title: "GBS Agent: API key",
    prompt: `API key for ${origin} (e.g. a Hugging Face token). Stored in VS Code secret storage and only sent to this endpoint.`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: "hf_... / sk-...",
  });
  if (value?.trim()) {
    await secrets.store(SECRET_KEY, JSON.stringify({ key: value.trim(), origin }));
    return value.trim();
  }
  return undefined;
}

// ─── Remote model consent ───────────────────────────────────────────────────

/** Where the conversation is sent, if it leaves this machine; undefined for local models. */
export function remoteDestination(cfg: AgentConfig, model: string): string | undefined {
  if (cfg.provider === "openai") {
    return isLoopbackUrl(cfg.openaiBaseUrl) ? undefined : originOf(cfg.openaiBaseUrl);
  }
  if (!isLoopbackUrl(cfg.ollamaBaseUrl)) {
    return originOf(cfg.ollamaBaseUrl);
  }
  return /[:-]cloud$/i.test(model) ? "Ollama cloud (ollama.com)" : undefined;
}
