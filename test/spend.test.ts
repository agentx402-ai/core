import { describe, expect, it } from "vitest";
import {
  AgentXError,
  assertFiniteUsd,
  parseErrorBody,
  SpendCapError,
  SpendLedger,
} from "../src/index";

describe("assertFiniteUsd — a malformed cap fails CLOSED", () => {
  it("allows an absent cap", () => {
    expect(() => assertFiniteUsd(undefined, "maxSpendUsd")).not.toThrow();
    expect(() => assertFiniteUsd(null, "maxSpendUsd")).not.toThrow();
  });

  it("allows a finite non-negative number, including 0", () => {
    for (const ok of [0, 0.005, 1_000]) {
      expect(() => assertFiniteUsd(ok, "maxSpendUsd")).not.toThrow();
    }
  });

  // NaN is the dangerous one: `usd > NaN` is false, so an unchecked NaN cap does not merely
  // fail to bind — it silently disables the comparison while reading as configured.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, "0,05", {}, true])(
    "rejects %s with invalid_config",
    (bad) => {
      let err: unknown;
      try {
        assertFiniteUsd(bad, "maxSpendUsd");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AgentXError);
      expect((err as AgentXError).code).toBe("invalid_config");
    },
  );
});

describe("SpendLedger — per-call and cumulative bounds", () => {
  it("validates its caps at construction", () => {
    expect(() => new SpendLedger({ maxSpendUsd: Number.NaN })).toThrow(/non-negative finite/);
    expect(() => new SpendLedger({ maxSessionSpendUsd: -1 })).toThrow(/non-negative finite/);
    expect(() => new SpendLedger()).not.toThrow();
  });

  it("refuses a spend over the per-call cap and allows one exactly at it", () => {
    const l = new SpendLedger({ maxSpendUsd: 0.005 });
    expect(() => l.assertSpend(0.006)).toThrow(SpendCapError);
    expect(() => l.assertSpend(0.005)).not.toThrow(); // at-cap is allowed: an off-by-one would throw
  });

  it("counts settled spend against the cumulative cap", () => {
    const l = new SpendLedger({ maxSessionSpendUsd: 0.009 });
    l.record(0.005);
    expect(l.settled).toBe(0.005);
    expect(() => l.assertSpend(0.005)).toThrow(SpendCapError);
    expect(() => l.assertSpend(0.004)).not.toThrow();
  });

  // The reservation is the whole reason this class exists.
  it("counts IN-FLIGHT reservations against the cumulative cap", () => {
    const l = new SpendLedger({ maxSessionSpendUsd: 0.005 });
    const release = l.assertAndReserve(0.004);
    expect(l.inFlight).toBe(0.004);
    // A second op checking before the first settles must see the first's in-flight amount.
    // Without the reservation this passes, and both sign — the measured $0.012-against-$0.005 bug.
    expect(() => l.assertSpend(0.004)).toThrow(SpendCapError);
    release();
    expect(l.inFlight).toBe(0);
    expect(() => l.assertSpend(0.004)).not.toThrow();
  });

  it("release is idempotent, so a double call cannot hand budget back twice", () => {
    const l = new SpendLedger({ maxSessionSpendUsd: 1 });
    const release = l.reserve(0.5);
    release();
    release();
    expect(l.inFlight).toBe(0);
  });

  it("a settled op moves its amount from in-flight to settled", () => {
    const l = new SpendLedger({ maxSessionSpendUsd: 1 });
    const release = l.assertAndReserve(0.5);
    l.record(0.5);
    release();
    expect(l.settled).toBe(0.5);
    expect(l.inFlight).toBe(0);
  });

  it("a FAILED op releases without charging", () => {
    const l = new SpendLedger({ maxSessionSpendUsd: 1 });
    const release = l.assertAndReserve(0.5);
    release(); // no record() — the op failed
    expect(l.settled).toBe(0);
    expect(l.inFlight).toBe(0);
  });

  it("with no caps configured nothing is refused, but the ledger still tracks", () => {
    const l = new SpendLedger();
    expect(() => l.assertSpend(1_000)).not.toThrow();
    l.record(1_000);
    expect(l.settled).toBe(1_000);
  });
});

describe("parseErrorBody — untrusted input", () => {
  it("reads error, code and hint", () => {
    expect(
      parseErrorBody(`{"error":"invalid key","code":"invalid_key","hint":"use [a-z]"}`, "fb"),
    ).toEqual({
      detail: "invalid key",
      code: "invalid_key",
      hint: "use [a-z]",
    });
  });

  it("falls back on a non-JSON body rather than throwing", () => {
    expect(parseErrorBody("<html>502</html>", "read failed")).toEqual({
      detail: "read failed",
      code: "request_failed",
    });
  });

  it("omits hint entirely when absent (never an explicit undefined)", () => {
    const parsed = parseErrorBody(`{"error":"boom","code":"internal_error"}`, "fb");
    expect("hint" in parsed).toBe(false);
  });

  // A non-string code would silently break every `e.code === "…"` comparison downstream.
  it("ignores non-string fields instead of propagating them", () => {
    expect(parseErrorBody(`{"error":{"a":1},"code":42,"hint":["x"]}`, "fb")).toEqual({
      detail: "fb",
      code: "request_failed",
    });
  });

  it("ignores empty strings", () => {
    expect(parseErrorBody(`{"error":"","code":"","hint":""}`, "fb")).toEqual({
      detail: "fb",
      code: "request_failed",
    });
  });
});

describe("SpendLedger — float accumulation must not refuse an at-cap spend", () => {
  // Regression: $0.005 settled + a $0.004 op is 0.009000000000000001 in IEEE-754, so a bare
  // `<=` refused a spend landing exactly ON a $0.009 cap. Both service SDKs carry this shape
  // today on their cumulative caps.
  it("allows a spend that reaches the cap exactly, despite float error", () => {
    const l = new SpendLedger({ maxSessionSpendUsd: 0.009 });
    l.record(0.005);
    expect(0.005 + 0.004).toBeGreaterThan(0.009); // the float error being absorbed
    expect(() => l.assertSpend(0.004)).not.toThrow();
  });

  it("still refuses a spend genuinely over the cap", () => {
    const l = new SpendLedger({ maxSessionSpendUsd: 0.009 });
    l.record(0.005);
    expect(() => l.assertSpend(0.005)).toThrow(SpendCapError);
  });

  it("the slack is sub-atomic — it cannot admit even one atomic USDC over", () => {
    const l = new SpendLedger({ maxSpendUsd: 0.005 });
    expect(() => l.assertSpend(0.005 + 0.000001)).not.toThrow(); // exactly the slack
    expect(() => l.assertSpend(0.005 + 0.00001)).toThrow(SpendCapError); // 10x it: refused
  });
});
