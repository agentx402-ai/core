# Changelog

All notable changes to `@agentx402-ai/core` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] — Initial release

### Added

The shared x402/EIP-712 platform SDK for agentx402 services:

- x402 payment-header construction (EIP-3009 `transferWithAuthorization`), with the signed
  authorization window clamped and the challenge network + canonical USDC asset pinned, so a
  compromised server cannot redirect or widen a payment.
- EIP-712 identity signing with host-binding and domain pinning.
- CAIP-2 network handling and idempotency-key nonces.
- A timeout + full-jitter + HTTP-date `Retry-After` retry layer (`fetchWithRetry`).
- The shared error taxonomy and machine-readable usage envelope.

Extracted from the `agentkv` monorepo into its own repo so it can be versioned and consumed
independently by `@agentkv/client`, `@agentkv/cli`, and future agentx402 services.

[0.1.0]: https://github.com/agentx402-ai/core/releases/tag/v0.1.0
