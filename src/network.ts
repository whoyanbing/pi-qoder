export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_ERROR_BODY_BYTES = 16 * 1024;

export type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

/** Run an HTTP request whose deadline covers both headers and response-body reads. */
export async function fetchWithTimeout(
  input: URL | RequestInfo,
  init: RequestInit = {},
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    fetch?: FetchLike;
    label?: string;
  } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const timeoutController = timeoutMs > 0 ? new AbortController() : undefined;
  const timeout = timeoutController
    ? setTimeout(
        () => timeoutController.abort(new Error(`${options.label || "Qoder request"} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
    : undefined;
  timeout?.unref?.();

  const clearDeadline = () => {
    if (timeout) clearTimeout(timeout);
  };
  const signals = [init.signal, options.signal, timeoutController?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  try {
    const response = await (options.fetch ?? globalThis.fetch)(input, { ...init, signal });
    if (!response.body || !timeoutController) {
      clearDeadline();
      return response;
    }

    // fetch resolves when headers arrive. Keep the deadline alive while callers
    // consume json/text/body by returning a response backed by a guarded stream.
    const reader = response.body.getReader();
    let settled = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearDeadline();
      void reader.cancel(timeoutController.signal.reason).catch(() => {});
      streamController?.error(timeoutController.signal.reason || new Error(`${options.label || "Qoder request"} timed out`));
    };
    timeoutController.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearDeadline();
      timeoutController.signal.removeEventListener("abort", onAbort);
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      async pull(controller) {
        if (settled) return;
        try {
          const { done, value } = await reader.read();
          if (settled) return;
          if (done) {
            settled = true;
            cleanup();
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          if (settled) return;
          settled = true;
          cleanup();
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (!settled) {
          settled = true;
          cleanup();
        }
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    clearDeadline();
    if (timeoutController?.signal.aborted && !options.signal?.aborted && !init.signal?.aborted) {
      throw timeoutController.signal.reason instanceof Error
        ? timeoutController.signal.reason
        : new Error(`${options.label || "Qoder request"} timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  }
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes = MAX_ERROR_BODY_BYTES,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
