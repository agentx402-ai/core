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

/** The service-error fields every worker on this platform returns. */
export interface ParsedErrorBody {
  /** Human-readable failure text — the body's `error`, else the caller's fallback label. */
  detail: string;
  /** Machine code callers dispatch on. `request_failed` when the body carries none. */
  code: string;
  /** The actionable half, when the service supplied one. */
  hint?: string;
}

/**
 * Parse a worker's `{ error, code, hint }` failure body. Each service SDK wraps the result in
 * its OWN error class — that class identity is what callers `instanceof` — so only the parsing
 * is shared, not the construction.
 *
 * EVERY FIELD IS TYPE-CHECKED because the body is untrusted: `JSON.parse` returns `any` and a
 * cast asserts nothing at runtime. A non-string `code` would silently break every
 * `e.code === "…"` comparison callers branch on, and a non-string `hint` renders as
 * "[object Object]" wherever it is surfaced. Anything that is not a non-empty string falls back
 * to the defaults. A non-JSON body is not an error here — it yields the fallback label and
 * `request_failed`, which is what a proxy's HTML error page should look like to a caller.
 *
 * `hint` matters more than it looks: these workers put the GENERIC message in `error` and the
 * ACTIONABLE detail in `hint`, so dropping it leaves callers with only the canned string. Both
 * client SDKs did exactly that until 2026-07-31, one of them for its whole published life.
 */
export function parseErrorBody(bodyText: string, fallback: string): ParsedErrorBody {
  let detail = fallback;
  let code = "request_failed";
  let hint: string | undefined;
  try {
    const body = JSON.parse(bodyText) as { error?: unknown; code?: unknown; hint?: unknown };
    if (typeof body?.error === "string" && body.error) detail = body.error;
    if (typeof body?.code === "string" && body.code) code = body.code;
    if (typeof body?.hint === "string" && body.hint) hint = body.hint;
  } catch {
    /* non-JSON body — keep the fallback label + request_failed */
  }
  return hint === undefined ? { detail, code } : { detail, code, hint };
}

Object.defineProperty(AgentXError, Symbol.hasInstance, {
  value: brandedHasInstance(AgentXError, AGENTX_ERROR_BRAND),
});
Object.defineProperty(SpendCapError, Symbol.hasInstance, {
  value: brandedHasInstance(SpendCapError, SPEND_CAP_BRAND),
});
