# Changelog

All notable changes to `@agentx402-ai/core` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.2.0] — Unreleased

Money-path hardening release: the safety pins become safe-by-default, the untrusted
challenge gets a typed error taxonomy, and the retry layer's cancellation/classification
contract is fixed. Breaking for callers that relied on unpinned defaults — released as a
minor (0.x) so consumers floating `^0.1.x` are not auto-upgraded.

### Breaking

- **`buildPaymentHeader` and `challengePriceUsd` now require `expectedNetwork`** (throw a
  fail-closed `unpinned_network` otherwise). The default call previously ran zero validation
  and signed whatever chain/token/amount/recipient a hostile 402 dictated.
  `{ allowUnpinnedNetwork: true }` is the explicit escape hatch.
- **Malformed `PAYMENT-REQUIRED` challenges now throw typed `AgentXError`s** (code
  `invalid_challenge`) instead of raw `SyntaxError`/`TypeError`/viem errors: bad base64/JSON,
  missing/empty/null `accepts`, non-integer or non-2 `x402Version`, malformed
  `payTo`/`asset`/`amount`/`maxTimeoutSeconds`. `chainIdFromCaip2` accepts canonical CAIP-2
  only (rejects hex/exponent/leading-zero/whitespace forms; code `unsupported_network`).
- **Terminal transport failures from `fetchWithRetry` are wrapped** as `AgentXError` code
  `network_error` with the original error as `cause` (previously the raw `TypeError`/
  `DOMException` escaped). Caller aborts still surface as the original abort reason.
- **`engines.node` floor raised to `>=20.3`** (native `AbortSignal.any`; the manual
  fallback — which leaked listeners — is deleted).
- A challenge whose `extra.name`/`extra.version` disagrees with the pinned asset-registry
  EIP-712 domain now throws a diagnosable `domain_mismatch` instead of signing a payload the
  server would reject (core deliberately signs registry values only).

### Added

- **`opts.maxAmountAtomic`** on `buildPaymentHeader`: a bigint ceiling on the signed amount,
  enforced before signing (`SpendCapError`).
- **`opts.idempotencyKey`** on `fetchWithRetry`: injects a stable `Idempotency-Key` header on
  every attempt (structural support for the no-double-charge contract).
- **`nonceFromIdempotencyKey(key, binding?)`**: optional `{ from, chainId, verifyingContract }`
  domain separation so the same key can recur across services/chains without an EIP-3009
  nonce collision (unbound keys must stay globally unique per logical payment).
- `amountAtomic` accepts `number | bigint | string`; unsafe-integer numbers are rejected
  (`invalid_amount`) instead of silently rounding, and digit strings/bigints support
  18-decimal-asset scales.
- `challengePriceUsd` derives its USD divisor from the asset registry's `decimals` instead of
  a hardcoded 1e6, and rejects non-digit challenge amounts.
- Cross-format `instanceof`: `AgentXError`/`SpendCapError` carry process-global `Symbol.for`
  brands, so `instanceof` holds when a process reaches the package through both `import` and
  `require` (the dual esm+cjs build previously broke the single-class invariant across that
  boundary). `err.code` remains the fully version-proof dispatch contract.
- Money-path regression tests now live in core itself: pins reject-before-signing, the
  1000×-misprice guard, the hostile-window clamp (`MAX_AUTH_WINDOW_SEC`), an absolute
  x402/EIP-712 domain parity pin (hardcoded, mirroring the client's and backend's), identity
  domain literals, retry exhaustion bounds, and a post-build dual-format dist smoke.

### Fixed

- **A caller abort delivered via `build()`'s `RequestInit.signal` — the standard fetch
  cancellation idiom — was misclassified as a transient network failure** and retried to
  exhaustion, re-invoking `build()` (i.e. re-signing) after cancel. Both abort channels now
  surface immediately, including mid-backoff (the sleep wakes early instead of dispatching
  one more attempt).
- `build()` exceptions (deterministic signing/key failures) propagate immediately instead of
  being retried with full backoff and mislabeled `network_error`.
- `Retry-After` parsing: only digit-form delta-seconds and *future* HTTP-dates are honored;
  negative or date-parseable garbage falls back to jittered backoff instead of a 0ms
  un-jittered retry. 408 joined the transient set (the one 4xx RFC 9110 permits repeating).
- The backoff jitter is now correctly documented as **equal jitter** (it always was
  behaviorally); docs previously called it full jitter.
- `fetchWithRetry`'s no-double-charge docstring is now stated as a caller REQUIREMENT
  (stable `Idempotency-Key` + pinned EIP-3009 nonce; sign payment headers once, outside
  `build()`) rather than implied behavior the function itself never enforced.
- The 0.1.0 changelog bullet below overstated the shipped defaults; see the correction note.

### Packaging

- `prepack` builds `dist/` (a publish from a stale checkout can no longer pack an empty
  API surface); `CHANGELOG.md` and `SECURITY.md` ship in the tarball; the inert
  `overrides.ws` was removed.
- CI: Node 20/22/24 matrix, coverage wired, and a post-build dist import smoke.
- Lint: `noExplicitAny`/`noNonNullAssertion`/`noUnusedFunctionParameters` re-enabled
  repo-wide as errors, with the one intentional structural `any` (viem's generic
  `signTypedData`) explicitly annotated.

### Release integrity

Hardening of the pipeline that produces the published tarball — relevant to anyone
depending on a package that signs USDC authorizations. See `SECURITY.md`.

- **The job holding npm trusted-publishing rights now runs no third-party code**: no
  dependency install, no bundler, no test runner, and `npm publish --ignore-scripts`.
  Install/build/test/audit moved to a separate unprivileged job with no `id-token`
  permission that hands over only the built `dist/`, which the publish job verifies.
- Installs use `--ignore-scripts` in CI and release, so a compromised transitive
  dependency gets no execution merely from being installed.
- GitHub Actions are pinned to commit SHAs rather than mutable tags, with Dependabot
  configured to keep the pins current; both workflows declare least-privilege
  `permissions` and check out with `persist-credentials: false`.
- A tag↔version guard refuses to publish unless the tag being released matches
  `package.json` at that tag; the tag's commit is always what gets built and published,
  never branch HEAD. The `release` environment now restricts deployments to `v*` tags, and a
  prerelease tag publishes under the `next` dist-tag so it can never take `latest`.
- A high-severity `npm audit` finding in a runtime dependency blocks CI and release; one
  in the dev/build chain blocks CI, where it is still fixable on a branch. The one
  outstanding advisory (`esbuild` GHSA-g7r4-m6w7-qqqr, low, dev-only) is cleared by an
  `overrides` pin to `esbuild@^0.28.1`; a `SECURITY.md` reporting policy is now published.

## [0.1.1] — 2026-07-26

### Fixed
- **The package page now links to this repository.** 0.1.0 was published from inside the `agentkv`
  monorepo, before `core` was extracted into its own repo, so npm recorded
  `repository: git+https://github.com/agentx402-ai/agentkv.git`. The `repository` field in
  `package.json` has pointed at `agentx402-ai/core` since this repo's initial commit; published
  metadata is immutable, so correcting it on npm required a release. No code changes.

### Changed
- Publish workflow now runs `npm publish` verbosely and prints the OIDC token-exchange result.
  A trusted-publishing misconfiguration otherwise surfaces as a misleading `E404 Not Found`, which
  reads as "package missing" rather than "never authenticated" — that ambiguity cost a sibling repo
  five CI runs to diagnose.

## [0.1.0] — Initial release

### Added

The shared x402/EIP-712 platform SDK for agentx402 services:

- x402 payment-header construction (EIP-3009 `transferWithAuthorization`), with the signed
  authorization window clamped unconditionally, and OPT-IN challenge pins
  (`expectedNetwork`/`expectedPayTo`) for the network + canonical USDC asset and the
  recipient. *(Correction, 2026-07-28: this bullet originally claimed the network/asset pins
  were unconditional — in 0.1.x they only applied when the caller passed the options. 0.2.0
  makes them required-by-default.)*
- EIP-712 identity signing with host-binding and domain pinning.
- CAIP-2 network handling and idempotency-key nonces.
- A timeout + equal-jitter + HTTP-date `Retry-After` retry layer (`fetchWithRetry`).
- The shared error taxonomy and machine-readable usage envelope.

Extracted from the `agentkv` monorepo into its own repo so it can be versioned and consumed
independently by `@agentkv/client`, `@agentkv/cli`, and future agentx402 services.

[0.1.1]: https://github.com/agentx402-ai/core/releases/tag/v0.1.1
[0.1.0]: https://github.com/agentx402-ai/core/releases/tag/v0.1.0
