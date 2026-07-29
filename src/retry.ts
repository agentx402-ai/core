// core/src/retry.ts
//
// Pure retry helpers factored out of `AgentKV#fetchWithRetry` / `AgentKV#retryDelay`.
// The original methods only ever read `this.maxRetries` (a plain number) and called
// `this.retryDelay` — no other instance state — so they extract cleanly into pure
// functions parameterized by `maxRetries`. `AgentKV` now delegates to these via thin
// private wrappers so every existing call site (`this.fetchWithRetry(...)`) is unchanged.

import { AgentXError } from "./errors";

/** Default per-attempt request timeout (ms). A hung-open connection would otherwise wedge an op forever. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Tuning knobs for {@link fetchWithRetry}. All optional; sensible defaults. */
export interface RetryOptions {
  /** Per-ATTEMPT timeout in ms (via `AbortSignal.timeout`). Default 30_000. Pass 0 to disable. */
  timeoutMs?: number;
  /** Injectable `fetch` for proxies / instrumentation / tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Caller `AbortSignal` to cancel the whole operation (abort is surfaced immediately, never retried). */
  signal?: AbortSignal;
  /**
   * Idempotency key injected as the `Idempotency-Key` header on EVERY attempt (unless the
   * attempt's own headers already set one), so a retry of an already-processed request
   * dedupes server-side. This is the structural alternative to keeping the header stable
   * by hand inside `build()` — see the no-double-charge requirement on {@link fetchWithRetry}.
   */
  idempotencyKey?: string;
}

/**
 * Combine 0+ AbortSignals into one that aborts when any input does. Undefined if none supplied.
 * `AbortSignal.any` is Node >=20.3 (the `engines` floor) / all modern browsers.
 */
function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => !!s);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/** Release a transient response's body so its socket returns to the pool before we retry. */
async function drainBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // best-effort — a body that can't be cancelled is not worth failing the retry over.
  }
}

/** Inject the Idempotency-Key header unless the attempt's own headers already carry one. */
function withIdempotencyKey(init: RequestInit, key: string): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has("Idempotency-Key")) headers.set("Idempotency-Key", key);
  return { ...init, headers };
}

/**
 * Issue a request with bounded retry on TRANSIENT failures only: a thrown
 * fetch (network error / lost response / per-attempt timeout) or a 5xx/429/408
 * response. After `maxRetries` transient RESPONSES, the last response is returned
 * as-is; after `maxRetries` thrown fetches, the failure is thrown wrapped in an
 * `AgentXError` (code `network_error`, original as `cause`). NOT retried:
 * - any other 2xx/4xx (incl. a 402 credit->pay handoff, 401, 404) — returned as-is;
 * - a caller-initiated abort — via `opts.signal` OR a `signal` inside the
 *   `RequestInit` that `build()` returns — surfaced immediately, including
 *   mid-backoff (the sleep wakes early);
 * - a `build()` throw — deterministic (a signing refusal, a bad key), propagated
 *   immediately and never labeled a network failure.
 *
 * `build()` is re-invoked per attempt so a caller can re-sign per-attempt state
 * (e.g. a fresh identity nonce). NO-DOUBLE-CHARGE REQUIREMENT: this function has
 * no knowledge of payment state, so dedup of an already-charged request is the
 * CALLER's contract — every `build()` invocation must send the same
 * `Idempotency-Key` (or pass `opts.idempotencyKey` and let this function inject
 * it) and, on paid ops, the same pinned EIP-3009 nonce. Sign payment headers
 * ONCE, outside `build()`, and re-send the identical header; a fresh nonce per
 * attempt makes a lost-but-settled response double-charge on retry.
 *
 * Honors `Retry-After` (delta-seconds or a future HTTP-date). Each attempt is
 * bounded by `opts.timeoutMs` (default 30s).
 */
export async function fetchWithRetry(
  url: string,
  build: () => RequestInit | Promise<RequestInit>,
  maxRetries: number,
  opts: RetryOptions = {},
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The caller-cancellation signals of the CURRENT attempt (opts.signal + the signal inside
  // build()'s RequestInit). Checked at loop top so an abort during backoff never dispatches
  // (or re-signs) another attempt.
  let callerSignal: AbortSignal | undefined;
  for (let attempt = 0; ; attempt++) {
    // Pre-dispatch abort gate: a cancel must never send (or re-sign) another attempt —
    // enforced here rather than left to the fetch implementation, so it holds even under
    // a signal-ignoring custom fetchImpl.
    opts.signal?.throwIfAborted();
    callerSignal?.throwIfAborted();
    // build() runs OUTSIDE the retried try: a deterministic build() failure (signing
    // refusal, bad key, decode error) propagates immediately, un-retried and un-relabeled.
    let init = await build();
    if (opts.idempotencyKey !== undefined) init = withIdempotencyKey(init, opts.idempotencyKey);
    callerSignal = combineSignals([init.signal ?? undefined, opts.signal]);
    callerSignal?.throwIfAborted();
    try {
      const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const signal = combineSignals([callerSignal, timeoutSignal]);
      const res = await doFetch(url, { ...init, signal });
      // Retry TRANSIENT statuses: 5xx, 429 (rate limited), 408 (the one 4xx RFC 9110 permits repeating).
      const transient =
        (res.status >= 500 && res.status <= 599) || res.status === 429 || res.status === 408;
      if (transient && attempt < maxRetries) {
        await drainBody(res);
        await retryDelay(attempt, res, callerSignal);
        continue;
      }
      return res;
    } catch (err) {
      // A caller-initiated cancel is intentional, not transient — surface it immediately,
      // whichever channel delivered it (opts.signal or build()'s RequestInit.signal).
      if (callerSignal?.aborted) {
        throw err instanceof Error ? err : new AgentXError(String(err), "aborted", 0);
      }
      if (attempt < maxRetries) {
        await retryDelay(attempt, undefined, callerSignal);
        continue;
      }
      if (err instanceof AgentXError) throw err;
      throw new AgentXError(err instanceof Error ? err.message : String(err), "network_error", 0, {
        cause: err,
      });
    }
  }
}

/**
 * Short, bounded backoff between retries. Base is 50ms, 100ms, ... capped at 500ms, with
 * equal jitter (each delay uniformly in [50%, 100%] of the base) to avoid a synchronized
 * retry herd under a 5xx/429 storm. If the response carries a `Retry-After` — delta-seconds
 * (digits only) OR a FUTURE HTTP-date — honor it up to a 2s cap so a re-sent paid
 * authorization still stays comfortably within its validBefore window (jitter is skipped when
 * the server dictates a delay); a malformed, negative, or past value falls back to the
 * jittered backoff. If `signal` aborts during the sleep, the promise resolves early so the
 * caller can surface the abort without waiting out the delay.
 */
export function retryDelay(attempt: number, res?: Response, signal?: AbortSignal): Promise<void> {
  const base = Math.min(500, 50 * 2 ** attempt);
  let ms = Math.round(base * (0.5 + Math.random() * 0.5));
  const retryAfter = res?.headers.get("Retry-After");
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) {
      ms = Math.min(2000, Number(retryAfter) * 1000); // delta-seconds form (non-negative digits)
    } else {
      const when = Date.parse(retryAfter); // HTTP-date form — only honored when in the future
      if (Number.isFinite(when) && when > Date.now()) ms = Math.min(2000, when - Date.now());
    }
  }
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
