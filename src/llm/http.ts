export class CancelledError extends Error {
  constructor() {
    super("Cancelled by user.");
    this.name = "CancelledError";
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    service: string,
    /** Retries spent before giving up; 0 when the request was not retried. */
    readonly retries = 0,
  ) {
    super(`${service} returned HTTP ${status}${retries > 0 ? ` after ${retries} ${retries === 1 ? "retry" : "retries"}` : ""}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof CancelledError ||
    (err instanceof Error && (err.name === "AbortError" || err.name === "CancelledError"))
  );
}

/** Statuses worth retrying: the endpoint is busy or rate limiting, not refusing the request. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** A Retry-After longer than this is treated as "come back later", not something to wait out. */
const MAX_HONOURED_RETRY_AFTER_MS = 60_000;

export interface RetryInfo {
  /** 1 for the first retry. */
  attempt: number;
  maxRetries: number;
  delayMs: number;
  status: number;
  service: string;
}

export interface RetryOptions {
  /** Retries after the first attempt. 0 disables retrying. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called before each wait, so the UI can say what is happening. */
  onRetry?: (info: RetryInfo) => void;
}

const DEFAULT_RETRY: Required<Omit<RetryOptions, "onRetry">> = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/** Retry-After is either seconds or an HTTP date. Undefined when absent or unusable. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) {
    return undefined;
  }
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** A sleep that gives up the moment the run is cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancelledError();
  }
}

/**
 * POSTs JSON and returns the streaming response.
 *
 * Busy endpoints (429 from a rate limit or an overloaded provider, 5xx from a gateway) are
 * retried with exponential backoff and jitter, honouring Retry-After when the server sends one.
 * Without this a single transient 429 — common on free tiers — would end the whole turn.
 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
  service: string,
  retry: RetryOptions = {},
): Promise<Response> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY, ...retry };
  const payload = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: payload,
        signal,
        // Never forward the Authorization header (or the code in the body) to wherever a redirect points.
        redirect: "error",
      });
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        throw new CancelledError();
      }
      const cause = (err as { cause?: { code?: string } })?.cause?.code;
      throw new Error(`Could not reach ${service} at ${url}${cause ? ` (${cause})` : ""}. Is it running and reachable?`);
    }

    if (response.ok) {
      if (!response.body) {
        throw new Error(`${service} returned an empty response body.`);
      }
      return response;
    }

    const text = await response.text().catch(() => "");
    const requested = retryAfterMs(response);
    const retryable =
      RETRYABLE_STATUS.has(response.status) &&
      attempt < maxRetries &&
      (requested === undefined || requested <= MAX_HONOURED_RETRY_AFTER_MS);
    if (!retryable) {
      throw new HttpError(response.status, text, service, attempt);
    }

    // Exponential backoff with jitter, unless the server named a delay itself.
    const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    const delayMs = Math.round(requested ?? backoff * (0.75 + Math.random() * 0.5));
    retry.onRetry?.({ attempt: attempt + 1, maxRetries, delayMs, status: response.status, service });
    await sleep(delayMs, signal);
  }
}

export interface StreamLimits {
  /** Total characters accepted before the stream is aborted (protects against endless responses). */
  maxChars: number;
  /** Abort when no data arrives for this long. Generous, because large local models can take minutes to load. */
  idleMs: number;
}

export const DEFAULT_STREAM_LIMITS: StreamLimits = { maxChars: 20_000_000, idleMs: 5 * 60_000 };
const MAX_LINE_CHARS = 5_000_000;

/** Yields complete lines from a streamed body, buffering partial lines across chunks. */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  limits: StreamLimits = DEFAULT_STREAM_LIMITS,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let buffer = "";
  let total = 0;
  try {
    while (true) {
      let idleTimer: NodeJS.Timeout | undefined;
      let stalled = false;
      const stallError = () => new Error(`The model server sent no data for ${Math.round(limits.idleMs / 1000)}s; the request was aborted.`);
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => {
          stalled = true;
          reader.cancel().catch(() => undefined);
          reject(stallError());
        }, limits.idleMs);
      });
      idle.catch(() => undefined);
      const chunk = await Promise.race([reader.read(), idle])
        .catch((err: unknown) => {
          throw signal.aborted ? new CancelledError() : err;
        })
        .finally(() => clearTimeout(idleTimer));
      if (stalled) {
        throw stallError();
      }
      if (chunk.done) {
        break;
      }
      const text = decoder.decode(chunk.value, { stream: true });
      total += text.length;
      if (total > limits.maxChars || buffer.length + text.length > MAX_LINE_CHARS) {
        reader.cancel().catch(() => undefined);
        throw new Error("The model server response exceeded the size limit; the request was aborted.");
      }
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      yield buffer;
    }
    if (signal.aborted) {
      throw new CancelledError();
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
