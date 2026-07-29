// core/src/errors.ts
//
// The SINGLE error base class object for the installed workspace. `@agentkv/client`
// (and any future second service package) must DEPEND ON and RE-EXPORT this class —
// never re-declare it — or `err instanceof AgentKVError` breaks for anything caught
// across a package boundary (two distinct class objects in node_modules).
//
// One copy is still TWO runtime classes: the package ships dual esm+cjs builds, so a
// process reaching core through both `import` and `require` holds two class objects
// from one installed tarball. The Symbol.for() brands below (process-global registry
// keys) make `instanceof` hold across that boundary — and across duplicated installs
// of compatible versions. `err.code` remains the fully format-proof dispatch contract.

/** Process-global brand for AgentXError instances (Symbol.for: same symbol in every copy). */
const AGENTX_ERROR_BRAND = Symbol.for("@agentx402-ai/core:AgentXError");

/** Process-global brand for SpendCapError instances. */
const SPEND_CAP_BRAND = Symbol.for("@agentx402-ai/core:SpendCapError");

/** Does `value` carry `brand`? (own or inherited; brands are set per-instance). */
function hasBrand(value: unknown, brand: symbol): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    (value as Record<symbol, unknown>)[brand] === true
  );
}

/** Base error carrying a machine code (mapped to CLI exit codes / MCP errors). */
export class AgentXError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    // Keep the original runtime `.name` string ("AgentKVError") so any existing
    // logging/serialization that reads `err.name` sees no observable change from
    // the pre-extraction class — only the exported IDENTIFIER is renamed.
    this.name = "AgentKVError";
    // Non-enumerable so the brand never leaks into JSON/spread/logging output.
    Object.defineProperty(this, AGENTX_ERROR_BRAND, { value: true });
  }
}

/**
 * Back-compat alias: the base class shipped as `AgentKVError` before this
 * extraction. Re-export the SAME reference under the old name (not a second
 * `class AgentKVError extends AgentXError {}` declaration) so
 * `new AgentKVError(...) instanceof AgentKVError` and
 * `new AgentKVError(...) instanceof AgentXError` both hold, and so callers that
 * imported `AgentKVError` before this refactor keep compiling and matching.
 */
export { AgentXError as AgentKVError };

/** Thrown when a paying call would exceed a configured spend cap. */
export class SpendCapError extends AgentXError {
  constructor(message: string) {
    super(message, "spend_cap_exceeded");
    this.name = "SpendCapError";
    Object.defineProperty(this, SPEND_CAP_BRAND, { value: true });
  }
}

/**
 * Brand-aware `instanceof` for a class that OWNS a brand. When invoked with any other
 * receiver — a third-party subclass inheriting the static through the prototype chain —
 * it falls back to ordinary prototype semantics, so a branded base error never satisfies
 * `instanceof TheirSubclass`.
 *
 * Installed via `Object.defineProperty` with a plain function expression rather than a
 * `static [Symbol.hasInstance]` class method: transpilers (esbuild among them) rewrite
 * `this` inside static class members to the enclosing-class alias, which silently breaks
 * the receiver check. A plain function's `this` is left alone.
 */
function brandedHasInstance(
  owner: abstract new (...args: never[]) => unknown,
  brand: symbol,
): (value: unknown) => boolean {
  return function (this: unknown, value: unknown): boolean {
    if (this === owner) return hasBrand(value, brand);
    return Function.prototype[Symbol.hasInstance].call(this, value);
  };
}

Object.defineProperty(AgentXError, Symbol.hasInstance, {
  value: brandedHasInstance(AgentXError, AGENTX_ERROR_BRAND),
});
Object.defineProperty(SpendCapError, Symbol.hasInstance, {
  value: brandedHasInstance(SpendCapError, SPEND_CAP_BRAND),
});
