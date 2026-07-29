// core/test/dist-smoke.mjs
//
// Post-build smoke over the PACKED artifact (run `npm run build` first, then
// `node test/dist-smoke.mjs`). Two jobs:
//
// 1. Exports smoke: both dist formats (esm + cjs) actually load and carry the public
//    API — catches an exports-map / tsup regression that unit tests (which import
//    src/, never dist/) would ship silently.
// 2. F04 cross-format instanceof: the dual esm+cjs build creates TWO runtime class
//    objects from one installed copy; the Symbol.for brand must make
//    `err instanceof AgentXError` / `instanceof SpendCapError` hold across them
//    (agentkv/cli maps exit codes via exactly these checks).

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esm = await import("../dist/index.js");
const cjs = require("../dist/index.cjs");

const PUBLIC_API = [
  "AgentXError",
  "AgentKVError",
  "SpendCapError",
  "buildPaymentHeader",
  "buildIdentityHeaders",
  "buildBearerHeaders",
  "challengePriceUsd",
  "chainIdFromCaip2",
  "decodeBase64Utf8",
  "fetchWithRetry",
  "retryDelay",
  "freshNonce",
  "nonceFromIdempotencyKey",
  "nowSec",
  "DEFAULT_TIMEOUT_MS",
  "MAX_AUTH_WINDOW_SEC",
  "EIP712_DOMAIN_NAME",
  "EIP712_DOMAIN_VERSION",
];
for (const name of PUBLIC_API) {
  assert.ok(name in esm, `esm build missing export: ${name}`);
  assert.ok(name in cjs, `cjs build missing export: ${name}`);
}

// Cross-format instanceof (both directions, base + subclass), plus the alias.
const cjsSpend = new cjs.SpendCapError("cap");
assert.ok(cjsSpend instanceof esm.SpendCapError, "cjs SpendCapError instanceof esm.SpendCapError");
assert.ok(cjsSpend instanceof esm.AgentXError, "cjs SpendCapError instanceof esm.AgentXError");
assert.ok(
  cjsSpend instanceof esm.AgentKVError,
  "cjs SpendCapError instanceof esm.AgentKVError (alias)",
);

const esmSpend = new esm.SpendCapError("cap");
assert.ok(esmSpend instanceof cjs.SpendCapError, "esm SpendCapError instanceof cjs.SpendCapError");
assert.ok(esmSpend instanceof cjs.AgentXError, "esm SpendCapError instanceof cjs.AgentXError");

const esmBase = new esm.AgentXError("boom", "some_code");
assert.ok(esmBase instanceof cjs.AgentKVError, "esm AgentXError instanceof cjs.AgentKVError");
assert.ok(
  !(esmBase instanceof cjs.SpendCapError),
  "base error must NOT satisfy subclass instanceof",
);

// err.code stays the stable dispatch contract in both formats.
assert.equal(cjsSpend.code, "spend_cap_exceeded");
assert.equal(esmBase.code, "some_code");

console.log("dist smoke OK: exports present in both formats; cross-format instanceof holds");
