# Security Policy

`@agentx402-ai/core` signs **EIP-3009 `transferWithAuthorization` payloads** — USDC bearer
instruments — and EIP-712 identity assertions, from data supplied by a remote server. A defect
here can move real money, so we take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via either:

- GitHub's [private vulnerability reporting](https://github.com/agentx402-ai/core/security/advisories/new)
  (preferred), or
- email **contact@agentx402.ai** with a subject starting `SECURITY:`.

Please include a description, the affected version(s), reproduction steps, and the impact. We aim
to acknowledge within 72 hours and will keep you updated through remediation. Please give us a
reasonable window to ship a fix before any public disclosure.

## Scope

This repository is the shared platform SDK that service clients (`@agentkv/client`, and future
`agentx402` service SDKs) are thin wrappers over: x402 payment-header construction, EIP-712
identity signing, CAIP-2 handling, idempotency/nonce derivation, the retry layer, the error
taxonomy, and the usage envelope. In scope: anything in `src/`, the dependency tree, and the
release pipeline that produces the npm tarball.

Out of scope here: the hosted service backends (operated separately), and consumer-side issues that
live in a wrapping SDK rather than in this package.

## Threat model

The **`PAYMENT-REQUIRED` challenge is untrusted input.** It arrives from a server that may be
compromised, spoofed, or hostile, and it nominates the chain, token contract, amount, recipient,
and validity window of a payload this library is about to sign with the caller's wallet.

What the library guarantees:

- **Network + asset pinning is required, not optional.** `buildPaymentHeader` and
  `challengePriceUsd` refuse to run without `expectedNetwork` (`unpinned_network`), and reject a
  challenge whose network or token contract is not the caller's configured, canonical one
  (`network_mismatch` / `asset_mismatch`) **before anything is signed**. This blocks the
  cross-chain drain: handing a Base-configured client an Arbitrum challenge to spend the same
  EOA's Arbitrum USDC. `{ allowUnpinnedNetwork: true }` disables this and should be treated as a
  deliberate, audited exception.
- **The signed validity window is clamped unconditionally** to `MAX_AUTH_WINDOW_SEC` (3600s),
  regardless of a server-supplied `maxTimeoutSeconds`, so a hostile multi-year window cannot yield
  an authorization that stays spendable indefinitely.
- **Malformed challenges fail closed**, with a typed `err.code` and no signature: bad base64/JSON,
  missing or non-object `accepts`, an unexpected `x402Version`, or a malformed
  `payTo`/`asset`/`amount`/`maxTimeoutSeconds` all reject before reaching the signer.
- **Optional recipient and amount pins**: `expectedPayTo` (`payto_mismatch`) and `maxAmountAtomic`
  (`SpendCapError`), both enforced pre-signing.

What it does **not** guarantee — the caller's responsibility:

- **The amount ceiling is opt-in.** Without `maxAmountAtomic`, the signed amount is whatever the
  (network- and asset-pinned) challenge states. Callers moving non-trivial value should pass a
  ceiling, and wrapping SDKs should enforce their own spend caps as well.
- **Exactly-once is a caller contract.** `fetchWithRetry` has no payment state. A retry only
  dedupes server-side if every attempt carries the same `Idempotency-Key` **and** the same pinned
  EIP-3009 nonce; sign payment headers once, outside the retry loop. A fresh nonce per attempt can
  double-charge when a settled response is lost. Unbound `nonceFromIdempotencyKey(key)` values must
  be globally unique per logical payment, or use the `{ from, chainId, verifyingContract }` binding.
- **Clock integrity.** `validBefore` and identity timestamps derive from the local clock; a fast
  clock extends a bearer authorization's real-world life by exactly the skew. Keep hosts NTP-synced.
- **Key custody.** Wallet private keys and account bearer tokens (`ak_…`) are full-capability
  secrets. This library never logs them, and `buildBearerHeaders` puts the raw key on the wire over
  TLS only — but storage, environment hygiene, and process isolation are the caller's.

## Release integrity

The published tarball is the security boundary that matters most for a money-path dependency:

- **OIDC trusted publishing, no npm token** — nothing long-lived exists to steal — with npm
  **provenance attestations** emitted on every publish. (0.1.0 predates a working OIDC
  configuration and carries no attestation; 0.1.1 onward do.) The Trusted Publisher is bound
  to this repository, the `publish.yml` workflow, **and** its `release` environment, so a
  token minted by any other job or a modified copy of that workflow is rejected.
- **The job holding publishing rights runs no third-party code**: no dependency install, no
  bundler, no test runner, and `npm publish --ignore-scripts`. Install, build, test, and audit run
  in a separate unprivileged job with no `id-token` permission, which hands over only the built
  `dist/`. Read this precisely: it protects the publishing **credential**, not payload integrity —
  `dist/` is still produced by the bundler in the build job, so a compromised build dependency
  could still get its output published, provenance and all. The lockfile, `--ignore-scripts`, the
  audit gate, and SHA-pinned actions are what narrow that.
- **Installs use `--ignore-scripts`** in CI and release, so a compromised transitive dependency
  gains no execution merely from being installed.
- **Actions are pinned to commit SHAs**, not mutable tags, and Dependabot keeps those pins current.
- **A tag↔version guard** refuses to publish unless the release tag matches `package.json`, and
  the `release` environment restricts deployments to `v*` tags. A release always builds and
  publishes the tag's own commit, so the provenance attestation names the commit the shipped
  code actually came from.
- **A high-severity `npm audit` finding in a runtime dependency blocks both CI and release**; one
  in the dev/build chain blocks CI, where it can still be fixed on a branch.

Verify a published version with `npm audit signatures` and check its provenance on the package page.

## Known advisories

`package.json` carries an `overrides` entry pinning **`esbuild` to `^0.28.1`**, above the
`^0.27.0` range declared by `tsup`, to clear GHSA-g7r4-m6w7-qqqr. It is a build-toolchain pin only
(esbuild is not a runtime dependency and reaches no consumer), verified against the full build and
test suite, and should be dropped once `tsup` widens its own range.

## Supported versions

The latest released minor of `@agentx402-ai/core` receives security fixes.
