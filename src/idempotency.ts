// core/src/idempotency.ts
//
// Nonce helpers shared by the identity-signing and x402-payment paths.

import { concatHex, getAddress, keccak256, numberToHex, stringToHex, toHex } from "viem";

/** A fresh random bytes32 nonce (0x-prefixed, 64 hex chars). */
export function freshNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Derive a deterministic bytes32 EIP-3009 nonce from a caller idempotency key,
 * so retrying a logical write reuses the same authorization and the server's
 * idempotency record is hit (exactly-once across caller retries).
 *
 * WITHOUT `binding`, the nonce is a function of the key STRING ONLY. EIP-3009
 * nonces are consumed per (from, token contract) ON-CHAIN, so reusing one key
 * for two different logical payments from the same wallet on the same token —
 * e.g. the same key against two different services — yields the same nonce, and
 * the facilitator rejects the second authorization outright (a liveness brick,
 * not a double-spend). Unbound keys must therefore be globally unique per
 * logical payment.
 *
 * Passing `binding` domain-separates the nonce by payer + chain + token
 * contract, so the same key can safely recur across services/chains while
 * retries of the SAME logical payment still reuse the same authorization.
 * Addresses are checksum-normalized: case differences do not change the nonce.
 */
export function nonceFromIdempotencyKey(
  key: string,
  binding?: { from: string; chainId: number; verifyingContract: string },
): `0x${string}` {
  const keyHash = keccak256(stringToHex(key));
  if (!binding) return keyHash;
  return keccak256(
    concatHex([
      getAddress(binding.from),
      numberToHex(binding.chainId, { size: 32 }),
      getAddress(binding.verifyingContract),
      keyHash,
    ]),
  );
}
