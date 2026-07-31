// core/src/spend.ts
//
// The client-side spend bound every service SDK on this platform needs. It lived twice —
// once in @agentkv/client, once in @agentscout/client — under different names for the same
// function (`assertCapOption` vs `assertFiniteUsd`), which is how the two copies drifted
// without anyone noticing: a grep for one does not find the other. Both holes a 2026-07-31
// audit found were of that shape — one client had a guard, the other did not:
//   - agentscout checked its cumulative cap against a counter incremented only AFTER the
//     paid round-trip, so N concurrent ops all passed the same stale check and all signed;
//   - agentkv accepted a malformed cap without failing closed for a period.
// Core already owned `SpendCapError` while the logic that throws it lived in the clients;
// this puts the two together.

import { AgentXError, SpendCapError } from "./errors";

/**
 * Comparison slack, in USD, of about one atomic USDC unit.
 *
 * Money here is USD floats, and cumulative spend ACCUMULATES that error: $0.005 settled plus a
 * $0.004 op is 0.009000000000000001, so a spend landing exactly ON a $0.009 cap is refused by a
 * bare `<=`. Every real amount is a whole number of atomic USDC, so a sub-atomic slack cannot
 * admit a spend anyone could actually be charged — it only absorbs representation error. Same
 * reasoning, and the same magnitude, as the per-op price slack the service SDKs apply to a
 * quoted challenge.
 */
const USD_EPS = 0.000001;

/**
 * Reject a malformed money bound. A cap that is not a finite, non-negative number is
 * REFUSED here — never stored and silently ignored.
 *
 * The dangerous value is a non-finite one: `usd > NaN` is false, so an unchecked NaN cap
 * does not merely fail to bind, it silently disables every comparison downstream — the cap
 * reads as configured while bounding nothing. A malformed cap must fail CLOSED, never
 * become "unlimited". `undefined`/`null` mean "no cap configured" and are allowed through.
 */
export function assertFiniteUsd(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AgentXError(`${label} must be a non-negative finite number`, "invalid_config", 0);
  }
}

/** Bounds a {@link SpendLedger}. Both are optional; an absent bound is "no cap". */
export interface SpendLedgerOptions {
  /** Ceiling on any single paying op's server-quoted price. */
  maxSpendUsd?: number;
  /** Ceiling on cumulative spend across this ledger's lifetime. */
  maxSessionSpendUsd?: number;
}

/**
 * Per-call and cumulative spend bounds, with the reservation that makes the cumulative one
 * hold under concurrency.
 *
 * THE RESERVATION IS THE POINT. Settlement is only known after a paid round-trip, so a
 * ledger that counts only settled spend gives concurrent ops the same stale total: each
 * checks, each passes, each signs, and the cumulative cap bounds nothing. Callers therefore
 * RESERVE synchronously at the check — with no `await` between the two — and release when
 * the op settles or fails. Measured before this existed: three in-flight reads authorized
 * $0.012 against a $0.005 cap.
 *
 * Caps are validated at construction, so a malformed one throws here rather than silently
 * disabling itself later.
 */
export class SpendLedger {
  readonly maxSpendUsd?: number;
  readonly maxSessionSpendUsd?: number;
  private settledUsd = 0;
  private inFlightUsd = 0;

  constructor(opts: SpendLedgerOptions = {}) {
    assertFiniteUsd(opts.maxSpendUsd, "maxSpendUsd");
    assertFiniteUsd(opts.maxSessionSpendUsd, "maxSessionSpendUsd");
    this.maxSpendUsd = opts.maxSpendUsd;
    this.maxSessionSpendUsd = opts.maxSessionSpendUsd;
  }

  /** Cumulative spend that has actually settled. */
  get settled(): number {
    return this.settledUsd;
  }

  /** Spend authorized by ops that passed the check but have not yet settled or failed. */
  get inFlight(): number {
    return this.inFlightUsd;
  }

  /**
   * Throw `SpendCapError` if `usd` breaches either bound. In-flight reservations count
   * against the cumulative bound alongside settled spend.
   *
   * Every comparison is a negated `<=` rather than `>`: a non-finite operand then fails
   * CLOSED. Caps are validated finite at construction and a quoted price is digits-only
   * validated upstream, so this is hardening rather than a reachable hole — but it is the
   * last arithmetic before a signature, so it refuses rather than trusts.
   */
  assertSpend(usd: number): void {
    if (this.maxSpendUsd !== undefined && !(usd <= this.maxSpendUsd + USD_EPS)) {
      throw new SpendCapError(`spend $${usd} exceeds per-call cap $${this.maxSpendUsd}`);
    }
    if (
      this.maxSessionSpendUsd !== undefined &&
      !(this.settledUsd + this.inFlightUsd + usd <= this.maxSessionSpendUsd + USD_EPS)
    ) {
      throw new SpendCapError(
        `spend $${usd} would exceed session cap $${this.maxSessionSpendUsd} ` +
          `(settled $${this.settledUsd}, in flight $${this.inFlightUsd})`,
      );
    }
  }

  /**
   * Reserve `usd` against the cumulative bound SYNCHRONOUSLY. Returns a release function the
   * caller MUST invoke exactly once, in a `finally` — releasing is idempotent, so a double
   * call cannot hand budget back twice, but never releasing leaks it permanently and shrinks
   * the effective cap for the rest of the ledger's life.
   */
  reserve(usd: number): () => void {
    this.inFlightUsd += usd;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlightUsd -= usd;
    };
  }

  /**
   * {@link assertSpend} + {@link reserve}, for a path about to commit real money. Nothing may
   * `await` between the two, or the check it just passed is stale before the reservation lands.
   */
  assertAndReserve(usd: number): () => void {
    this.assertSpend(usd);
    return this.reserve(usd);
  }

  /** Move `usd` into settled spend. Call on success; the reservation is released separately. */
  record(usd: number): void {
    this.settledUsd += usd;
  }
}
