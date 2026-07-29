// core/test/errors.test.ts
//
// Money/correctness: the error base must be a SINGLE class object in
// the installed workspace. `AgentKVError` is an ALIAS (`export { AgentXError as
// AgentKVError }`), not a second class declaration — these tests pin that the
// alias is the exact same reference, that `instanceof` holds both ways, and
// that `SpendCapError extends AgentKVError` keeps working through the alias.
//
// A companion test (`client/test/errors.test.ts`) proves the SAME guarantee
// holds across the actual package boundary once `@agentkv/client` re-exports
// this class (rather than re-declaring it) — see that file for the
// cross-package half of this pin.
import { describe, expect, it } from "vitest";
import { AgentKVError, AgentXError, SpendCapError } from "../src/errors";

describe("AgentKVError / AgentXError single-class invariant", () => {
  it("AgentKVError IS AgentXError — the alias is the same reference, not a re-declaration", () => {
    expect(AgentKVError).toBe(AgentXError);
  });

  it("new AgentKVError(...) instanceof AgentKVError holds (imported-name construction)", () => {
    const err = new AgentKVError("boom", "some_code", 500);
    expect(err).toBeInstanceOf(AgentKVError);
    expect(err).toBeInstanceOf(AgentXError);
    expect(err.code).toBe("some_code");
    expect(err.status).toBe(500);
    // Runtime `.name` is unchanged by the rename (only the exported identifier changed).
    expect(err.name).toBe("AgentKVError");
  });

  it("new AgentXError(...) instanceof AgentKVError holds (canonical-name construction)", () => {
    const err = new AgentXError("boom", "some_code");
    expect(err).toBeInstanceOf(AgentKVError);
  });

  it("SpendCapError extends AgentKVError through the alias", () => {
    const err = new SpendCapError("cap exceeded");
    expect(err).toBeInstanceOf(SpendCapError);
    expect(err).toBeInstanceOf(AgentKVError);
    expect(err).toBeInstanceOf(AgentXError);
    expect(err.code).toBe("spend_cap_exceeded");
    expect(err.name).toBe("SpendCapError");
  });

  it("a base AgentXError is NOT instanceof SpendCapError", () => {
    // Guards the brand implementation: a naive inherited Symbol.hasInstance would make
    // every branded base error satisfy the subclass check.
    expect(new AgentXError("boom", "some_code") instanceof SpendCapError).toBe(false);
  });

  it("propagates an ErrorOptions cause (used by the retry layer's network_error wrap)", () => {
    const inner = new TypeError("socket reset");
    const err = new AgentXError("fetch failed", "network_error", 0, { cause: inner });
    expect(err.cause).toBe(inner);
  });
});

describe("dual-copy instanceof robustness (Symbol.for brand)", () => {
  // The published package ships BOTH dist/index.js (esm) and dist/index.cjs — a process
  // mixing `import` and `require` gets two distinct class objects from ONE installed copy.
  // The brand (a Symbol.for key, process-global) must make instanceof hold across copies.
  const AGENTX_BRAND = Symbol.for("@agentx402-ai/core:AgentXError");
  const SPEND_BRAND = Symbol.for("@agentx402-ai/core:SpendCapError");

  /** Simulates an error constructed by the OTHER module-format copy of this package. */
  function foreignCopyError(brands: symbol[]): Error {
    const e = new Error("boom");
    for (const b of brands) Object.defineProperty(e, b, { value: true });
    return e;
  }

  it("an error from a foreign copy satisfies instanceof AgentXError via the brand", () => {
    expect(foreignCopyError([AGENTX_BRAND]) instanceof AgentXError).toBe(true);
    expect(foreignCopyError([AGENTX_BRAND]) instanceof AgentKVError).toBe(true);
  });

  it("a foreign SpendCapError satisfies both instanceof checks", () => {
    const e = foreignCopyError([AGENTX_BRAND, SPEND_BRAND]);
    expect(e instanceof SpendCapError).toBe(true);
    expect(e instanceof AgentXError).toBe(true);
  });

  it("a foreign BASE error does not satisfy instanceof SpendCapError", () => {
    expect(foreignCopyError([AGENTX_BRAND]) instanceof SpendCapError).toBe(false);
  });

  it("a plain un-branded Error satisfies neither", () => {
    expect(new Error("x") instanceof AgentXError).toBe(false);
    expect(new Error("x") instanceof SpendCapError).toBe(false);
  });

  it("locally-constructed instances carry the brands (so the OTHER copy recognizes them)", () => {
    const base = new AgentXError("boom", "c") as unknown as Record<symbol, unknown>;
    const cap = new SpendCapError("cap") as unknown as Record<symbol, unknown>;
    expect(base[AGENTX_BRAND]).toBe(true);
    expect(cap[AGENTX_BRAND]).toBe(true);
    expect(cap[SPEND_BRAND]).toBe(true);
  });

  it("third-party subclasses keep ordinary prototype semantics (hasInstance falls back)", () => {
    class CustomError extends AgentXError {
      constructor(message: string) {
        super(message, "custom_code");
      }
    }
    expect(new CustomError("x") instanceof CustomError).toBe(true);
    expect(new CustomError("x") instanceof AgentXError).toBe(true);
    // A base error must NOT satisfy the subclass check just because it carries the base brand.
    expect(new AgentXError("x", "c") instanceof CustomError).toBe(false);
  });
});
