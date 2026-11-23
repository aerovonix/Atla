/**
 * Requests that back off instead of giving up.
 *
 * A tool-calling turn is not one request, it is one request per iteration, all
 * issued as fast as the tools resolve. Gemini's free tier allows on the order
 * of ten a minute, so a few tool steps exhaust the quota in seconds and every
 * provider here previously turned that into a dead turn: 429 went straight to
 * assertOk and the whole answer was lost, tool results included.
 *
 * Waiting is almost always the right response. The server usually says how
 * long to wait, and when it does not, doubling with jitter avoids a room full
 * of clients retrying in lockstep. Only the statuses that mean "later" are
 * retried -- a 400 or a 401 will say the same thing however long we wait.
 *
 * This lives apart from the provider adapters because the web tools need the
 * same treatment: a search that gets rate limited should wait and try again,
 * not report that the internet is empty.
 */

/** A non-OK response, carrying the status so callers can explain it. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

/** Honours Retry-After in both its forms: seconds, or an HTTP date. */
export function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RetryOptions {
  /**
   * The longest this caller can afford to wait between attempts. A server
   * asking for longer is taken at its word and its response handed straight
   * back, so the caller can say it was rate limited rather than sit through
   * the wait and report a timeout it caused itself.
   */
  maxWait?: number;
  attempts?: number;
  onWait?: (ms: number, attempt: number) => void;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {}
): Promise<Response> {
  const { maxWait = 60_000, attempts: maxAttempts = MAX_ATTEMPTS, onWait } = opts;
  // Every caller already puts the turn's abort signal in the init, and the
  // wait between attempts has to honour it too -- otherwise pressing Stop
  // leaves a retry sleeping in the background, to wake and fire a request the
  // person has already cancelled.
  const signal = (init.signal ?? new AbortController().signal) as AbortSignal;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, init);
    if (res.ok || !RETRYABLE.has(res.status)) return res;
    lastStatus = res.status;
    if (attempt === maxAttempts) return res;

    // Capped, because a server asking for five minutes is not something to
    // sit through silently -- better to fail and let the person decide.
    const told = retryAfterMs(res);
    const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * 250);
    const wait = told ?? backoff + jitter;
    // Longer than this caller can afford: hand the response back instead, so
    // whatever it says about the limit survives.
    if (wait > maxWait) return res;

    // The body holds the provider's explanation; read it so the connection is
    // freed, and so a final failure can still report what was said.
    await res.text().catch(() => "");

    onWait?.(wait, attempt);
    await sleep(wait, signal);
  }
  throw new Error(`HTTP ${lastStatus}: giving up after ${maxAttempts} attempts`);
}
