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

/** Yields complete lines from a streamed body, buffering partial lines across chunks. */
export async function* readLines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read().catch((err: unknown) => {
        throw signal.aborted ? new CancelledError() : err;
      });
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
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
