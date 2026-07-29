// core/src/payment.ts
//
// Payment/identity header builders, plus the `Signer` interface and EIP-712 domain
// constants they depend on. These travel together because
// `buildPaymentHeader`/`buildIdentityHeaders` are not truly standalone from them —
// splitting the functions from their domain constants would force a circular
// client<->core dependency.

import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { getDefaultAsset } from "@x402/evm";
import { getAddress } from "viem";
import { AgentXError, SpendCapError } from "./errors";
import { freshNonce } from "./idempotency";

/** Minimal signer the client needs: a viem account satisfies this structurally. */
export interface Signer {
  address: `0x${string}`;
  // biome-ignore lint/suspicious/noExplicitAny: viem's signTypedData is generic; accept it structurally
  signTypedData(args: any): Promise<`0x${string}`>;
}

/** EIP-712 domain name shared with the server's EIP-712 verifier. */
export const EIP712_DOMAIN_NAME = "AgentKV";

/** EIP-712 domain version shared with the server's EIP-712 verifier. */
export const EIP712_DOMAIN_VERSION = "1";

/**
 * Hard cap on the signed EIP-3009 authorization window, regardless of the server-supplied
 * `maxTimeoutSeconds`. A signed authorization is a bearer instrument; a hostile challenge
 * asking for a multi-year window must not yield one that stays spendable indefinitely.
 */
export const MAX_AUTH_WINDOW_SEC = 3600;

/** Canonical EVM address shape (40 hex chars); checksum is validated separately by viem. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Digits-only atomic amount (no sign, no exponent, no whitespace, no hex). */
const ATOMIC_AMOUNT_RE = /^[0-9]+$/;

/** Maps a CAIP-2 network id (e.g. "eip155:8453") to its numeric chainId. Canonical form only. */
export function chainIdFromCaip2(network: string): number {
  const [namespace, reference, ...rest] = network.split(":");
  if (
    rest.length > 0 ||
    namespace !== "eip155" ||
    reference === undefined ||
    !/^[1-9][0-9]*$/.test(reference)
  ) {
    throw new AgentXError(`unsupported CAIP-2 network: ${network}`, "unsupported_network", 0);
  }
  const id = Number(reference);
  if (!Number.isSafeInteger(id)) {
    throw new AgentXError(`invalid CAIP-2 chain id: ${network}`, "unsupported_network", 0);
  }
  return id;
}

/**
 * Decode a base64 header as UTF-8 (atob → char-code bytes → TextDecoder("utf-8")).
 * The backend encodes both PAYMENT-REQUIRED and PAYMENT-RESPONSE with base64/UTF-8 and
 * documents this exact mirror decode; a bare `atob()` decodes Latin-1, which corrupts
 * any non-ASCII code point (e.g. a future "USD₮" asset name). Byte-identical for ASCII.
 */
export function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/** EIP-712 typed-data shape shared with the server's EIP-712 verifier. */
const REQUEST_TYPES = {
  Request: [
    { name: "method", type: "string" },
    { name: "path", type: "string" },
    // host binds the signature to one deployment (prevents cross-deployment replay) —
    // must match the backend's EIP-712 type definitions exactly, or every identity op fails to verify.
    { name: "host", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "timestamp", type: "uint256" },
  ],
} as const;

/** Identity headers sent on free/credit operations. */
export interface IdentityHeaders {
  "X-AgentKV-Signature": string;
  "X-AgentKV-Nonce": string;
  "X-AgentKV-Timestamp": string;
}

/**
 * Bearer auth header for account-key mode. The opaque `ak_…` token IS the
 * capability: the server hashes it to name the account's storage and debits its
 * prepaid credits. NO x402, NO EIP-712 — this header replaces both. The raw key
 * travels in the clear over TLS exactly like any bearer token; never log it.
 */
export function buildBearerHeaders(accountKey: string): Record<string, string> {
  return { Authorization: `Bearer ${accountKey}` };
}

/** Current unix time in whole seconds. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** EIP-712 typed-data types for EIP-3009 transferWithAuthorization. */
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Each PAYMENT-REQUIRED accept is a full v2 PaymentRequirements. */
type ChallengeAccept = PaymentRequirements;

/** Decoded PAYMENT-REQUIRED challenge body. */
interface PaymentRequiredChallenge {
  x402Version: number;
  accepts: ChallengeAccept[];
}

/** Shorthand for the challenge-taxonomy error: the header is the primary UNTRUSTED input. */
function invalidChallenge(message: string): AgentXError {
  return new AgentXError(message, "invalid_challenge", 0);
}

/**
 * Validate + checksum-normalize a challenge-sourced address. Wraps viem's `getAddress`
 * so a hostile/garbled challenge surfaces a typed `invalid_challenge`, never a raw
 * viem `InvalidAddressError`.
 */
function checksumAddress(value: unknown, field: string): `0x${string}` {
  if (typeof value !== "string" || !EVM_ADDRESS_RE.test(value)) {
    throw invalidChallenge(`invalid ${field} in challenge: "${String(value)}"`);
  }
  try {
    return getAddress(value);
  } catch {
    throw invalidChallenge(`invalid ${field} in challenge (bad EIP-55 checksum): "${value}"`);
  }
}

/**
 * Decode and validate a base64-encoded PAYMENT-REQUIRED challenge header.
 * Every malformed variant throws a typed `invalid_challenge` — this header is the
 * primary untrusted input, so nothing may escape as a raw SyntaxError/TypeError.
 */
function decodeChallenge(paymentRequiredHeader: string): PaymentRequiredChallenge {
  let parsed: PaymentRequiredChallenge;
  try {
    parsed = JSON.parse(decodeBase64Utf8(paymentRequiredHeader)) as PaymentRequiredChallenge;
  } catch {
    throw invalidChallenge("PAYMENT-REQUIRED header is not valid base64-encoded JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.accepts)) {
    throw invalidChallenge("invalid PAYMENT-REQUIRED challenge: missing accepts array");
  }
  if (parsed.x402Version !== 2) {
    throw invalidChallenge(
      `unsupported x402Version in PAYMENT-REQUIRED challenge: ${String(parsed.x402Version)} (expected 2)`,
    );
  }
  return parsed;
}

/** Normalize a caller-supplied atomic amount to a canonical digit string, or throw typed. */
function atomicAmountString(amountAtomic: number | bigint | string): string {
  if (typeof amountAtomic === "number") {
    if (!Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) {
      throw new AgentXError(
        `amountAtomic must be a positive safe integer (use a bigint or digit string beyond 2^53): ${amountAtomic}`,
        "invalid_amount",
        0,
      );
    }
    return String(amountAtomic);
  }
  if (typeof amountAtomic === "bigint") {
    if (amountAtomic <= 0n) {
      throw new AgentXError(`amountAtomic must be positive: ${amountAtomic}`, "invalid_amount", 0);
    }
    return amountAtomic.toString();
  }
  if (!ATOMIC_AMOUNT_RE.test(amountAtomic) || BigInt(amountAtomic) <= 0n) {
    throw new AgentXError(
      `amountAtomic string must be a positive integer in atomic units: "${amountAtomic}"`,
      "invalid_amount",
      0,
    );
  }
  return BigInt(amountAtomic).toString(); // normalize leading zeros
}

/** Pick the exact-scheme requirement, by amount when several tiers are offered. */
function selectRequirement(
  accepts: ChallengeAccept[],
  amountAtomic?: number | bigint | string,
): ChallengeAccept {
  // Runtime-filter hostile entries (null / non-object / wrong scheme) — the array arrives
  // from an untrusted header, whatever the compile-time type claims.
  const exact = accepts.filter(
    (a): a is ChallengeAccept => !!a && typeof a === "object" && a.scheme === "exact",
  );
  const [first] = exact;
  if (first === undefined) {
    throw invalidChallenge("no acceptable x402 exact-scheme requirement in challenge");
  }
  if (amountAtomic !== undefined) {
    // Use the first exact requirement as the asset/payTo/network/domain template and
    // override the amount — supports any top-off / deposit amount, not just advertised tiers.
    return { ...first, amount: atomicAmountString(amountAtomic) };
  }
  if (exact.length > 1) {
    throw invalidChallenge(
      "ambiguous PAYMENT-REQUIRED challenge: multiple exact requirements; specify an amount",
    );
  }
  return first;
}

/**
 * Shape-validate the selected requirement BEFORE any `getAddress`/`BigInt`/arithmetic
 * touches it, so malformed fields surface as typed `invalid_challenge` errors instead
 * of raw viem/BigInt throws.
 */
function assertRequirementShape(req: ChallengeAccept): void {
  if (typeof req.network !== "string") {
    throw invalidChallenge(`invalid network in challenge: ${String(req.network)}`);
  }
  checksumAddress(req.payTo, "payTo address");
  checksumAddress(req.asset, "asset address");
  if (typeof req.amount !== "string" || !ATOMIC_AMOUNT_RE.test(req.amount)) {
    throw invalidChallenge(`invalid amount in challenge: "${String(req.amount)}"`);
  }
  if (
    req.maxTimeoutSeconds !== undefined &&
    (typeof req.maxTimeoutSeconds !== "number" ||
      !Number.isInteger(req.maxTimeoutSeconds) ||
      req.maxTimeoutSeconds < 0)
  ) {
    throw invalidChallenge(
      `invalid maxTimeoutSeconds in challenge: ${String(req.maxTimeoutSeconds)}`,
    );
  }
}

/**
 * Enforce that a server-supplied challenge targets the client's configured network AND its
 * canonical USDC contract. Money movement must never be dictated solely by the server: a
 * compromised or spoofed worker could otherwise return a challenge for a different chain
 * (e.g. hand a Base-configured client an Arbitrum challenge, draining the SAME EOA's
 * Arbitrum USDC) or a non-canonical token address, and the client would sign it. This is
 * the payment-path mirror of the host-binding on identity signatures and the domain pin.
 */
function assertNetworkParity(req: ChallengeAccept, expectedNetwork: string): void {
  if (req.network !== expectedNetwork) {
    throw new AgentXError(
      `payment challenge network "${req.network}" does not match client network "${expectedNetwork}"`,
      "network_mismatch",
      0,
    );
  }
  const asset = registryAsset(expectedNetwork);
  if (checksumAddress(req.asset, "asset address") !== getAddress(asset.address)) {
    throw new AgentXError(
      `payment challenge asset "${req.asset}" is not the canonical USDC for ${expectedNetwork}`,
      "asset_mismatch",
      0,
    );
  }
}

/** Registry lookup with a typed error for off-registry networks. */
function registryAsset(network: string): ReturnType<typeof getDefaultAsset> {
  try {
    return getDefaultAsset(network as `${string}:${string}`);
  } catch {
    throw new AgentXError(
      `no known asset registry entry for network "${network}"`,
      "unsupported_network",
      0,
    );
  }
}

/**
 * Decode a challenge and return the chosen requirement's price in USD.
 *
 * `expectedNetwork` is REQUIRED in practice (safe-by-default): it pins the challenge to the
 * client's configured network + canonical asset, and selects the decimals the USD divisor is
 * derived from. Passing `{ allowUnpinnedNetwork: true }` instead explicitly accepts pricing
 * whatever network the server declared (decimals then come from the server-declared
 * network's registry entry).
 */
export function challengePriceUsd(
  paymentRequiredHeader: string,
  amountAtomic?: number | bigint | string,
  expectedNetwork?: string,
  opts?: { allowUnpinnedNetwork?: boolean },
): number {
  if (expectedNetwork === undefined && !opts?.allowUnpinnedNetwork) {
    throw new AgentXError(
      "challengePriceUsd requires expectedNetwork (the client's configured network) — or pass { allowUnpinnedNetwork: true } to explicitly price whatever network the server declared",
      "unpinned_network",
      0,
    );
  }
  const { accepts } = decodeChallenge(paymentRequiredHeader);
  const req = selectRequirement(accepts, amountAtomic);
  assertRequirementShape(req);
  if (expectedNetwork !== undefined) assertNetworkParity(req, expectedNetwork);
  // Derive the USD divisor from the asset registry's decimals — a hardcoded /1e6 would
  // misprice an 18-decimal registry asset by 1e12. When pinned, the parity check above
  // guarantees req.asset IS the canonical asset for expectedNetwork.
  const decimals = registryAsset(expectedNetwork ?? req.network).decimals;
  return Number(req.amount) / 10 ** decimals;
}

/**
 * Build the base64 PAYMENT-SIGNATURE header from a PAYMENT-REQUIRED challenge.
 *
 * Decodes the v2 challenge, selects the matching `exact`-scheme requirement
 * (by `opts.amountAtomic` when several tiers are offered), and signs an EIP-3009
 * transferWithAuthorization payload (validAfter=0, validBefore=now+window) with
 * the viem account.
 *
 * SAFE-BY-DEFAULT: `opts.expectedNetwork` is required — a signed EIP-3009
 * authorization is a bearer instrument, and without the pin the client signs
 * whatever chain/token the server dictates. `{ allowUnpinnedNetwork: true }` is
 * the explicit escape hatch. `opts.maxAmountAtomic` bounds the signed amount
 * (throws `SpendCapError` before signing); `opts.expectedPayTo` pins the
 * recipient.
 *
 * NONCE CONTRACT: `opts.nonce` pins a deterministic EIP-3009 nonce so retries
 * reuse the same authorization and the server can dedupe an already-settled
 * payment. When omitted, every call signs a FRESH nonce — never re-invoke this
 * per retry attempt without pinning the nonce (see `nonceFromIdempotencyKey`),
 * or a lost-but-settled response can be charged twice on retry.
 *
 * CLOCK: `validBefore` derives from the LOCAL clock (`nowSec()`). A fast local
 * clock extends the authorization's real-world live window by exactly the skew;
 * a slow one yields already-expired authorizations the server rejects. Keep the
 * host clock NTP-synced; a server-side timestamp rejection on an otherwise-valid
 * op usually means local clock skew.
 *
 * Returns the base64-encoded JSON payload as the PAYMENT-SIGNATURE value.
 */
export async function buildPaymentHeader(
  account: Signer,
  paymentRequiredHeader: string,
  opts?: {
    /** Deterministic EIP-3009 nonce (pin to the op's idempotency key so retries dedupe). */
    nonce?: `0x${string}`;
    /** Override the template amount (top-off/deposit); positive integer in atomic units. */
    amountAtomic?: number | bigint | string;
    /** Pin the challenge to the client's configured network + canonical asset (required unless allowUnpinnedNetwork). */
    expectedNetwork?: string;
    /** Pin the recipient: reject the challenge unless its `payTo` equals this address (high-value ops). */
    expectedPayTo?: string;
    /** Hard ceiling on the signed amount in atomic units; exceeding challenges throw SpendCapError BEFORE signing. */
    maxAmountAtomic?: bigint;
    /** Explicitly sign whatever network/asset the server dictates (dangerous; for tooling that pins elsewhere). */
    allowUnpinnedNetwork?: boolean;
  },
): Promise<string> {
  if (opts?.expectedNetwork === undefined && !opts?.allowUnpinnedNetwork) {
    throw new AgentXError(
      "buildPaymentHeader requires expectedNetwork — a signed EIP-3009 authorization is a bearer instrument and must be pinned to the client's configured network. Pass { expectedNetwork } (recommended) or { allowUnpinnedNetwork: true } to explicitly sign whatever network/asset the server dictates.",
      "unpinned_network",
      0,
    );
  }
  const { x402Version, accepts } = decodeChallenge(paymentRequiredHeader);

  const req = selectRequirement(accepts, opts?.amountAtomic);
  assertRequirementShape(req);

  // Pin the money-moving challenge to the client's configured network + canonical asset
  // BEFORE signing anything (a signed EIP-3009 authorization is a bearer instrument).
  if (opts?.expectedNetwork !== undefined) assertNetworkParity(req, opts.expectedNetwork);
  const payTo = checksumAddress(req.payTo, "payTo address");
  // Optional recipient pin: for high-value ops a caller may pin the expected payTo.
  if (opts?.expectedPayTo && payTo !== getAddress(opts.expectedPayTo)) {
    throw new AgentXError(
      `payment challenge payTo "${req.payTo}" does not match expected "${opts.expectedPayTo}"`,
      "payto_mismatch",
      0,
    );
  }
  // Amount ceiling — the last line of defense against a hostile amount, enforced BEFORE signing.
  if (opts?.maxAmountAtomic !== undefined && BigInt(req.amount) > opts.maxAmountAtomic) {
    throw new SpendCapError(
      `challenge amount ${req.amount} exceeds maxAmountAtomic ${opts.maxAmountAtomic}`,
    );
  }

  const chainId = chainIdFromCaip2(req.network);
  // Look up EIP-712 domain info for the token (name/version) from the pinned registry.
  const asset = registryAsset(req.network);
  const verifyingContract = checksumAddress(req.asset, "asset address");

  // core deliberately signs REGISTRY domain values, never server-supplied `extra` — but a
  // challenge whose extra disagrees would fail signature verification server-side anyway,
  // so surface that as a typed, diagnosable client-side error instead of a silent DoS.
  if (req.extra && typeof req.extra === "object") {
    const { name, version } = req.extra as { name?: unknown; version?: unknown };
    if (
      (typeof name === "string" && name !== asset.name) ||
      (typeof version === "string" && version !== asset.version)
    ) {
      throw new AgentXError(
        `challenge extra EIP-712 domain ("${String(name)}"/"${String(version)}") disagrees with the pinned registry domain ("${asset.name}"/"${asset.version}") — core signs registry values only`,
        "domain_mismatch",
        0,
      );
    }
  }

  const nonce = opts?.nonce ?? freshNonce();
  const now = nowSec();
  // Clamp the signed window: never sign an authorization valid longer than MAX_AUTH_WINDOW_SEC,
  // regardless of the server-supplied maxTimeoutSeconds.
  const window = Math.min(req.maxTimeoutSeconds ?? 300, MAX_AUTH_WINDOW_SEC);
  const validBefore = String(now + window);

  const authorization = {
    from: getAddress(account.address),
    to: payTo,
    value: req.amount,
    validAfter: "0",
    validBefore,
    nonce,
  };

  const signature = await account.signTypedData({
    domain: {
      name: asset.name,
      version: asset.version,
      chainId,
      verifyingContract,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(account.address),
      to: payTo,
      value: BigInt(req.amount),
      validAfter: BigInt(0),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  // v2 PaymentPayload: the chosen requirement + the signed EIP-3009 authorization,
  // encoded with the SDK so the server's decodePaymentSignatureHeader round-trips.
  const paymentPayload: PaymentPayload = {
    x402Version,
    accepted: req,
    payload: {
      authorization,
      signature,
    },
  };

  return encodePaymentSignatureHeader(paymentPayload);
}

/**
 * Build EIP-712 identity headers for a free/credit op (delete, balance).
 * Signs the Request typed data with a fresh nonce + timestamp so the server
 * can recover the wallet address and enforce replay protection.
 */
export async function buildIdentityHeaders(
  account: Signer,
  args: { method: string; path: string; host: string; network: string },
): Promise<IdentityHeaders> {
  const nonce = freshNonce();
  const timestamp = nowSec();
  const signature = await account.signTypedData({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: chainIdFromCaip2(args.network),
    },
    types: REQUEST_TYPES,
    primaryType: "Request",
    message: {
      method: args.method,
      path: args.path,
      host: args.host,
      nonce,
      timestamp: BigInt(timestamp),
    },
  });

  return {
    "X-AgentKV-Signature": signature,
    "X-AgentKV-Nonce": nonce,
    "X-AgentKV-Timestamp": String(timestamp),
  };
}
