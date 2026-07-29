// core/test/retry.test.ts
//
// Focused unit tests for the extracted `fetchWithRetry`/`retryDelay`
// pure functions (previously private `AgentKV#fetchWithRetry`/`#retryDelay`
// methods keyed off `this.maxRetries`). These test the retry MECHANICS in
// isolation (transient-status detection, retry-count bound, Retry-After
// honoring, thrown-error passthrough) without any signing/idempotency
// machinery. The integration-level behavior — that `AgentKV` still reuses a
// stable Idempotency-Key / pinned nonce across an internal retry — continues
// to be covered by `client/test/retry.test.ts`, unchanged, now exercising the
// delegating wrapper around these functions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, retryDelay } from "../src/retry";

afterEach(() => vi.restoreAllMocks());

describe("fetchWithRetry", () => {
  it("retries a 5xx then succeeds", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n === 1 ? new Response("err", { status: 503 }) : new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", () => ({}), 2);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 then succeeds", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n === 1
        ? new Response("slow down", { status: 429 })
        : new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", () => ({}), 2);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 4xx (deterministic) — exactly one attempt", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", () => ({}), 2);
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 402 (deterministic payment handoff) — exactly one attempt", async () => {
    const fetchMock = vi.fn(async () => new Response("pay up", { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", () => ({}), 2);
    expect(res.status).toBe(402);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown fetch (lost response) then succeeds", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n === 1) throw new TypeError("network error");
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", () => ({}), 2);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries (maxRetries=2 -> 3 attempts total)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("https://x", () => ({}), 2)).rejects.toThrow(/network down/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("maxRetries=0 disables retry entirely (one attempt, surfaces the error)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("net down");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("https://x", () => ({}), 0)).rejects.toThrow(/net down/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("wraps a non-Error throw into an AgentXError-shaped error after exhausting retries", async () => {
    const fetchMock = vi.fn(async () => {
      // eslint-disable-next-line no-throw-literal
      throw "plain string failure";
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("https://x", () => ({}), 0)).rejects.toMatchObject({
      message: "plain string failure",
      code: "network_error",
    });
  });

  it("re-invokes build() per attempt (e.g. so a caller can re-sign with a fresh nonce)", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n === 1 ? new Response("err", { status: 503 }) : new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const build = vi.fn(() => ({ headers: { "X-Attempt": String(n) } }));
    await fetchWithRetry("https://x", build, 2);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("uses an injected fetch implementation instead of global fetch", async () => {
    const seen: string[] = [];
    const myFetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const res = await fetchWithRetry("https://injected", () => ({}), 0, { fetchImpl: myFetch });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["https://injected"]);
  });

  it("aborts a hung request after the per-attempt timeout, then retries", async () => {
    let attempts = 0;
    const hangUntilAbort = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        attempts++;
        init?.signal?.addEventListener("abort", () => reject(new Error("request-aborted")), {
          once: true,
        });
      })) as typeof fetch;
    await expect(
      fetchWithRetry("https://slow", () => ({}), 1, { timeoutMs: 20, fetchImpl: hangUntilAbort }),
    ).rejects.toThrow(/abort/i);
    expect(attempts).toBe(2); // maxRetries=1 -> 2 attempts, each timed out
  });

  it("surfaces a pre-aborted opts.signal immediately — no dispatch at all", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));
    let attempts = 0;
    // Deliberately signal-IGNORING fetch: proves the loop checks abort BEFORE dispatch
    // rather than relying on a spec-compliant fetch to reject.
    const f = (() => {
      attempts++;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;
    const build = vi.fn(() => ({}));
    await expect(
      fetchWithRetry("https://x", build, 3, { signal: ctrl.signal, fetchImpl: f }),
    ).rejects.toThrow(/cancelled/);
    expect(attempts).toBe(0);
    expect(build).toHaveBeenCalledTimes(0); // nothing re-signed after cancel either
  });

  it("surfaces a caller abort delivered via build()'s RequestInit.signal immediately without retrying", async () => {
    // The standard fetch cancellation idiom: the signal rides inside the RequestInit that
    // build() returns. It must be classified as a caller abort — NOT a transient network
    // error retried to exhaustion — and checked BEFORE dispatch, so even a
    // signal-ignoring fetchImpl sends nothing after cancel.
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));
    let attempts = 0;
    const build = vi.fn(() => ({ signal: ctrl.signal }));
    const f = (() => {
      attempts++;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;
    await expect(fetchWithRetry("https://x", build, 3, { fetchImpl: f })).rejects.toThrow(
      /cancelled/,
    );
    expect(attempts).toBe(0); // build() must run to expose its signal, but nothing dispatches
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("propagates a deterministic build() failure immediately — no retries, fetch never dispatched", async () => {
    // A build() throw (signing refusal, bad key, decode error) is deterministic, not
    // transient: retrying it re-runs the same failure with full backoff, and mislabels
    // a signing failure as a network failure.
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    const build = vi.fn(() => {
      throw new Error("signing refused");
    });
    await expect(fetchWithRetry("https://x", build, 3, { fetchImpl: fetchMock })).rejects.toThrow(
      /signing refused/,
    );
    expect(build).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("resolves with the LAST response after exhausting retries on a persistent 503", async () => {
    let n = 0;
    const f = (async () => new Response(`attempt-${n++}`, { status: 503 })) as typeof fetch;
    const fetchMock = vi.fn(f);
    const res = await fetchWithRetry("https://x", () => ({}), 2, { fetchImpl: fetchMock });
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3); // maxRetries=2 -> exactly 3 attempts
    await expect(res.text()).resolves.toBe("attempt-2"); // the last response, body intact
  });

  it("resolves with the LAST response after exhausting retries on a persistent 429", async () => {
    const fetchMock = vi.fn(async () => new Response("limited", { status: 429 }));
    const res = await fetchWithRetry("https://x", () => ({}), 2, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a 408 (the one 4xx RFC 9110 permits repeating) then succeeds", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n === 1
        ? new Response("request timeout", { status: 408 })
        : new Response("ok", { status: 200 });
    });
    const res = await fetchWithRetry("https://x", () => ({}), 2, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("wraps a terminal transport failure in AgentXError network_error with the original as cause", async () => {
    const boom = new TypeError("network down");
    const fetchMock = vi.fn(async () => {
      throw boom;
    });
    const p = fetchWithRetry("https://x", () => ({}), 0, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await expect(p).rejects.toMatchObject({ code: "network_error", message: "network down" });
    await p.catch((e) => expect(e.cause).toBe(boom));
  });

  it("honors an abort during backoff: no further build() or fetch after cancel", async () => {
    // Abort fires while the loop sleeps a server-dictated Retry-After. The sleep must wake
    // early and surface the abort — not finish the sleep and dispatch one more signed attempt.
    const ctrl = new AbortController();
    let fetches = 0;
    const build = vi.fn(() => ({}));
    const f = (async () => {
      fetches++;
      return new Response("err", { status: 503, headers: { "Retry-After": "1" } });
    }) as typeof fetch;
    const started = Date.now();
    setTimeout(() => ctrl.abort(new Error("stop-now")), 30);
    await expect(
      fetchWithRetry("https://x", build, 3, { signal: ctrl.signal, fetchImpl: f }),
    ).rejects.toThrow(/stop-now/);
    expect(Date.now() - started).toBeLessThan(800); // woke early, did not sleep the full 1s
    expect(fetches).toBe(1);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("timeoutMs: 0 disables the per-attempt timeout (no signal attached when none supplied)", async () => {
    let seen: AbortSignal | null | undefined = null;
    const f = (async (_url: unknown, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const res = await fetchWithRetry("https://x", () => ({}), 0, { timeoutMs: 0, fetchImpl: f });
    expect(res.status).toBe(200);
    expect(seen).toBeUndefined();
  });

  it("injects opts.idempotencyKey as the Idempotency-Key header on every attempt", async () => {
    const keys: (string | null)[] = [];
    let n = 0;
    const f = (async (_url: unknown, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key"));
      n++;
      return n === 1 ? new Response("err", { status: 503 }) : new Response("ok", { status: 200 });
    }) as typeof fetch;
    await fetchWithRetry("https://x", () => ({}), 2, { fetchImpl: f, idempotencyKey: "op-1" });
    expect(keys).toEqual(["op-1", "op-1"]); // stable across attempts -> server-side dedup holds
  });

  it("does not clobber an Idempotency-Key that build() set explicitly", async () => {
    let seen: string | null = null;
    const f = (async (_url: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers).get("Idempotency-Key");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    await fetchWithRetry("https://x", () => ({ headers: { "Idempotency-Key": "explicit" } }), 0, {
      fetchImpl: f,
      idempotencyKey: "injected",
    });
    expect(seen).toBe("explicit");
  });
});

describe("retryDelay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("honors Retry-After (seconds) up to the 2s cap", async () => {
    vi.useFakeTimers();
    const res = new Response(null, { headers: { "Retry-After": "5" } });
    let resolved = false;
    retryDelay(0, res).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it("honors Retry-After in HTTP-date form up to the 2s cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    // 1s in the future (whole second — HTTP-date has no sub-second precision) -> ~1000ms, under the 2s cap.
    const when = new Date("2026-01-01T00:00:01.000Z").toUTCString();
    const res = new Response(null, { headers: { "Retry-After": when } });
    let resolved = false;
    retryDelay(0, res).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it("ignores a malformed Retry-After and falls back to jittered exponential backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // pin full base (no downward jitter)
    vi.useFakeTimers();
    const res = new Response(null, { headers: { "Retry-After": "not-a-number" } });
    let resolved = false;
    retryDelay(0, res).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it("caps exponential backoff at 500ms with no Retry-After", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // pin full base
    vi.useFakeTimers();
    let resolved = false;
    retryDelay(10).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it("applies equal jitter (down to 50% of base) so retries don't synchronize", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // minimum jitter -> 50% of base
    vi.useFakeTimers();
    let resolved = false;
    retryDelay(10).then(() => {
      resolved = true;
    }); // base 500 -> 250ms
    await vi.advanceTimersByTimeAsync(249);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it("honors Retry-After '0' (valid delta form) as an immediate retry", async () => {
    vi.useFakeTimers();
    const res = new Response(null, { headers: { "Retry-After": "0" } });
    let resolved = false;
    retryDelay(0, res).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });

  it("falls back to jittered backoff on a negative Retry-After (not a 0ms un-jittered retry)", async () => {
    // '-5' is not a valid delta-seconds form, and V8's Date.parse date-parses it to a PAST
    // date (year 2001) — both branches must reject it and keep the computed backoff.
    vi.spyOn(Math, "random").mockReturnValue(1); // pin full base (50ms at attempt 0)
    vi.useFakeTimers();
    const res = new Response(null, { headers: { "Retry-After": "-5" } });
    let resolved = false;
    retryDelay(0, res).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it("falls back to jittered backoff on a PAST HTTP-date Retry-After", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // pin full base (50ms at attempt 0)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
    const past = new Date("2026-01-01T00:00:00.000Z").toUTCString();
    const res = new Response(null, { headers: { "Retry-After": past } });
    let resolved = false;
    retryDelay(0, res).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it("wakes early when the supplied signal aborts during the sleep", async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const res = new Response(null, { headers: { "Retry-After": "2" } }); // 2s server-dictated
    let resolved = false;
    retryDelay(0, res, ctrl.signal).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);
    ctrl.abort(new Error("cancelled"));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true); // resolves early; the retry loop surfaces the abort
  });
});
