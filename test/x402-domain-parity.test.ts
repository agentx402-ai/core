// core/test/x402-domain-parity.test.ts
//
// Pin the x402 USDC asset + EIP-712 domain that core sources from getDefaultAsset(network).
// buildPaymentHeader() (src/payment.ts) signs the EIP-3009 TransferWithAuthorization over
// { name: asset.name, version: asset.version, ... }, and the facilitator verifies that
// signature against the BACKEND's requirements — which the backend builds from
// getDefaultAsset(network) too. Both sides must agree byte-for-byte or EVERY paid op fails.
//
// package.json floats `@x402/evm: ^2.16.0`, so a registry change in a future 2.x would
// otherwise ship silently: core's other domain test builds its expectation from
// getDefaultAsset itself, so both sides move together and can never catch drift. This
// HARDCODED table is the absolute pin — the same EXPECTED values as the client's and the
// backend's x402-domain-parity tests. A @x402/evm bump that changes any field must be
// applied to ALL THREE in lockstep (a one-sided bump breaks every paid op).
// NB: Base mainnet (8453) name is "USD Coin" but Base Sepolia (84532) name is "USDC".
import { getDefaultAsset } from "@x402/evm";
import { describe, expect, it } from "vitest";

const EXPECTED = {
  "eip155:8453": {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  },
  "eip155:84532": {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    version: "2",
    decimals: 6,
  },
} as const;

describe("x402 USDC asset + EIP-712 domain parity (matches the client + backend pins)", () => {
  it("getDefaultAsset(network).{address,name,version,decimals} match the pinned cross-repo values", () => {
    for (const network of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
      const asset = getDefaultAsset(network);
      const want = EXPECTED[network];
      expect(asset.address.toLowerCase()).toBe(want.address.toLowerCase());
      expect(asset.name).toBe(want.name);
      expect(asset.version).toBe(want.version);
      // challengePriceUsd derives its USD divisor from decimals — a drift misprices by 10^n.
      expect(asset.decimals).toBe(want.decimals);
    }
  });
});
