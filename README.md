# @agentx402-ai/core

Shared x402/EIP-712 platform SDK plumbing — auth, payment, usage, error, and retry handling —
extracted from `@agentkv/client` for reuse across future `agentx402` service SDKs.

## Money-path API

`buildPaymentHeader(account, paymentRequiredHeader, opts)` signs a USDC **EIP-3009
`transferWithAuthorization`** — a bearer instrument — from an untrusted server-supplied
`PAYMENT-REQUIRED` challenge. It is **safe-by-default**:

- **`opts.expectedNetwork` is required.** The challenge is pinned to your configured CAIP-2
  network and its canonical USDC contract *before anything is signed*; a mismatch throws
  `network_mismatch` / `asset_mismatch`. Without the pin, a compromised server could hand a
  Base-configured client an Arbitrum challenge and drain the same EOA's Arbitrum USDC.
  `{ allowUnpinnedNetwork: true }` is the explicit, dangerous escape hatch.
- **`opts.maxAmountAtomic`** (bigint) caps the signed amount; an over-ceiling challenge throws
  `SpendCapError` before signing. Strongly recommended — the amount is otherwise
  server-dictated.
- **`opts.expectedPayTo`** pins the recipient (`payto_mismatch` on drift).
- The signed validity window is clamped to `MAX_AUTH_WINDOW_SEC` (3600s) unconditionally.
- The window and identity timestamps derive from the **local clock**: a fast clock extends a
  bearer authorization's real-world validity by exactly the skew, a slow one produces
  already-expired authorizations and server-rejected timestamps. Keep the host clock
  NTP-synced; a server-side timestamp rejection usually means local skew.

### Nonce & idempotency contract (no-double-charge)

An EIP-3009 authorization is deduped server-side by its nonce, and ops by their
`Idempotency-Key`. To make a retry of an already-charged request safe:

- Sign the payment header **once**, outside any retry loop, with
  `opts.nonce: nonceFromIdempotencyKey(key)` pinned to the op's idempotency key — and re-send
  the identical header on every attempt. A fresh nonce per attempt double-charges when a
  charged response is lost.
- Send the **same `Idempotency-Key` header on every attempt** (`fetchWithRetry`'s
  `opts.idempotencyKey` injects it for you).
- Unbound `nonceFromIdempotencyKey(key)` derives from the key string alone, so keys must be
  globally unique per logical payment. Pass the optional
  `{ from, chainId, verifyingContract }` binding to domain-separate the nonce per
  payer/chain/token instead.

### Retry layer

`fetchWithRetry(url, build, maxRetries, opts)` retries **transient failures only** (thrown
fetch, 5xx, 429, 408; honors `Retry-After`). A caller abort — via `opts.signal` or a `signal`
inside the `RequestInit` that `build()` returns — surfaces immediately, even mid-backoff, and
a `build()` throw (e.g. a signing refusal) propagates without retry. Terminal transport
failures are wrapped as `AgentXError` code `network_error` with the original as `cause`.

## Error handling

Every error this package throws on its documented paths is an `AgentXError` carrying a
machine-readable **`err.code`** (`invalid_challenge`, `network_mismatch`, `asset_mismatch`,
`payto_mismatch`, `unpinned_network`, `unsupported_network`, `domain_mismatch`,
`invalid_amount`, `spend_cap_exceeded`, `network_error`, `aborted`). **`err.code` is the
stable dispatch contract** — prefer it for exit codes and machine handling.

`instanceof AgentXError` / `instanceof SpendCapError` also work across module-format
boundaries: the package ships dual esm+cjs builds (two runtime class objects from one
install), and a process-global `Symbol.for` brand keeps `instanceof` true across them, and
across duplicated installs of compatible versions. It still fails across **incompatible
majors** (each major brands its own contract) — `err.code` never does.

`@agentkv/client` re-exports `AgentXError` as `AgentKVError`; both names are the same class
object.

## Key handling

Account keys (`ak_…`) and wallet private keys are bearer capabilities. Never log, print, or
persist them; `buildBearerHeaders` puts the raw key on the wire over TLS only.

## License

MIT
