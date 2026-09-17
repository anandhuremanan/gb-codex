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
  ) {
    super(`${service} returned HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof CancelledError ||
    (err instanceof Error && (err.name === "AbortError" || err.name === "CancelledError"))
  );
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CancelledError();
  }
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
  service: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
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
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new HttpError(response.status, text, service);
  }
  if (!response.body) {
    throw new Error(`${service} returned an empty response body.`);
  }
  return response;
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
