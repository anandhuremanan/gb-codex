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

export function readConfig(): AgentConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    provider: c.get<ProviderKind>("provider", "ollama"),
    model: c.get<string>("model", "deepseek-v4-flash:cloud").trim(),
    subagentModel: c.get<string>("subagentModel", "").trim(),
    ollamaBaseUrl: c.get<string>("ollama.baseUrl", "http://localhost:11434"),
    openaiBaseUrl: c.get<string>("openai.baseUrl", "https://router.huggingface.co/v1"),
    contextWindow: Math.max(4096, c.get<number>("contextWindow", 32768)),
    maxOutputTokens: Math.max(512, c.get<number>("maxOutputTokens", 8192)),
    temperature: c.get<number>("temperature", 0.2),
    maxSteps: Math.max(1, c.get<number>("maxSteps", 60)),
    permissionMode: c.get<PermissionMode>("permissionMode", "acceptEdits"),
    commandTimeoutSeconds: Math.max(5, c.get<number>("commandTimeoutSeconds", 120)),
    maxToolOutputChars: Math.max(2000, c.get<number>("maxToolOutputChars", 20000)),
    shell: c.get<string>("shell", "").trim(),
  };
}

/** Updates a setting at the scope where it is currently defined (workspace if set there, else global). */
export async function updateConfig(key: string, value: unknown): Promise<void> {
  const c = vscode.workspace.getConfiguration(SECTION);
  const inspected = c.inspect(key);
  const target =
    inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await c.update(key, value, target);
}

const SECRET_KEY = "gbsAgent.apiKey";

export async function getApiKey(secrets: vscode.SecretStorage, prompt: boolean): Promise<string | undefined> {
  const c = vscode.workspace.getConfiguration(SECTION);
  const fromSecret = await secrets.get(SECRET_KEY);
  const key =
    fromSecret ||
    c.get<string>("openai.apiKey", "") ||
    c.get<string>("huggingfaceToken", "") ||
    process.env.HF_TOKEN ||
    process.env.OPENAI_API_KEY;
  if (key || !prompt) {
    return key || undefined;
  }
  const baseUrl = c.get<string>("openai.baseUrl", "");
  if (/localhost|127\.0\.0\.1/.test(baseUrl)) {
    return undefined;
  }
  return promptForApiKey(secrets);
}

export async function promptForApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: "GBS Agent: API key",
    prompt: "API key for the OpenAI-compatible endpoint (e.g. a Hugging Face token). Stored in VS Code secret storage.",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "hf_... / sk-...",
  });
  if (value) {
    await secrets.store(SECRET_KEY, value.trim());
    return value.trim();
  }
  return undefined;
}
