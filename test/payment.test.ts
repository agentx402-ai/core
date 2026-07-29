// core/test/payment.test.ts
//
// Moved from client/test/payment.test.ts — this is now the primary,
// deep test suite for the extracted buildPaymentHeader/buildIdentityHeaders/
// freshNonce/nonceFromIdempotencyKey plumbing. client/test/payment.test.ts
// keeps a thin back-compat smoke test asserting the re-exported names still
// resolve and work identically through the client package.

import { getDefaultAsset } from "@x402/evm";
import { getAddress, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildBearerHeaders,
  buildIdentityHeaders,
  buildPaymentHeader,
  chainIdFromCaip2,
  challengePriceUsd,
  decodeBase64Utf8,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  freshNonce,
  MAX_AUTH_WINDOW_SEC,
  nonceFromIdempotencyKey,
  nowSec,
  type Signer,
} from "../src/index";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const NETWORK = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x0000000000000000000000000000000000000001";

/** A signer that must never be reached: pins the "reject BEFORE signing" invariant. */
function neverSigner(address: `0x${string}`): Signer & { signTypedData: ReturnType<typeof vi.fn> } {
  return {
    address,
    signTypedData: vi.fn(async () => {
      throw new Error("signTypedData must not be called");
    }),
  };
}

/** A single-accept exact challenge with per-field overrides. */
function challengeWith(overrides: Record<string, unknown> = {}): string {
  return encodeChallenge([
    {
      scheme: "exact",
      network: NETWORK,
      amount: "5000",
      asset: USDC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      ...overrides,
    },
  ]);
}

describe("payment.freshNonce", () => {
  it("returns a 32-byte (bytes32) hex and is fresh each call", () => {
    const a = freshNonce();
    const b = freshNonce();
    expect(a).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(b).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("payment.buildIdentityHeaders", () => {
  const account = privateKeyToAccount(PK);

  it("produces headers whose signature recovers the wallet address", async () => {
    const headers = await buildIdentityHeaders(account, {
      method: "DELETE",
      path: "/kv/session",
      host: "agentkv.example",
      network: NETWORK,
    });

    expect(headers["X-AgentKV-Signature"]).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(headers["X-AgentKV-Nonce"]).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(Number(headers["X-AgentKV-Timestamp"])).toBeGreaterThan(0);

    const valid = await verifyTypedData({
      address: account.address,
      domain: {
        name: EIP712_DOMAIN_NAME,
        version: EIP712_DOMAIN_VERSION,
        chainId: chainIdFromCaip2(NETWORK),
      },
      types: {
        Request: [
          { name: "method", type: "string" },
          { name: "path", type: "string" },
          { name: "host", type: "string" },
          { name: "nonce", type: "bytes32" },
          { name: "timestamp", type: "uint256" },
        ],
      },
      primaryType: "Request",
      message: {
        method: "DELETE",
        path: "/kv/session",
        host: "agentkv.example",
        nonce: headers["X-AgentKV-Nonce"] as `0x${string}`,
        timestamp: BigInt(headers["X-AgentKV-Timestamp"]),
      },
      signature: headers["X-AgentKV-Signature"] as `0x${string}`,
    });

    expect(valid).toBe(true);
  });

  it("uses a fresh nonce and timestamp per call", async () => {
    const h1 = await buildIdentityHeaders(account, {
      method: "GET",
      path: "/credits/balance",
      host: "agentkv.example",
      network: NETWORK,
    });
    const h2 = await buildIdentityHeaders(account, {
      method: "GET",
      path: "/credits/balance",
      host: "agentkv.example",
      network: NETWORK,
    });
    expect(h1["X-AgentKV-Nonce"]).not.toBe(h2["X-AgentKV-Nonce"]);
  });
});

function encodeChallenge(accepts: unknown[]): string {
  const json = JSON.stringify({ x402Version: 2, accepts });
  return btoa(json);
}

describe("payment.buildPaymentHeader", () => {
  const account = privateKeyToAccount(PK);

  it("decodes the PAYMENT-REQUIRED challenge and returns a base64 PAYMENT-SIGNATURE", async () => {
    const challenge = encodeChallenge([
      {
        scheme: "exact",
        network: NETWORK,
        amount: "5000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
        resource: "/kv/session",
        description: "write",
        mimeType: "application/json",
        maxTimeoutSeconds: 300,
      },
    ]);

    const header = await buildPaymentHeader(account, challenge, { expectedNetwork: NETWORK });

    expect(typeof header).toBe("string");
    expect(header.length).toBeGreaterThan(0);
    // base64 alphabet only
    expect(header).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);

    // decodes to a v2 payment payload referencing the exact scheme & payer. Assert on the
    // ACTUAL field the encoder emits (paymentPayload.accepted.scheme) — the old
    // `decoded.scheme ?? decoded.payload?.scheme ?? "exact"` fell through to the "exact"
    // literal and could never fail, so a wrong/absent scheme would have passed silently.
    const decoded = JSON.parse(atob(header));
    expect(decoded.accepted.scheme).toBe("exact");
    expect(decoded.x402Version).toBe(2);
  });

  it("the signed EIP-3009 authorization VERIFIES against the exact domain + message (recovers the payer)", async () => {
    // Cryptographic pin: a regression that signs the wrong domain — wrong
    // chainId, verifyingContract, or asset name/version — still base64-decodes fine and keeps
    // the right value/nonce, so it passes every other test yet the facilitator rejects every
    // paid op. This recovers the signer from the signature, so a domain drift fails it.
    const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const challenge = encodeChallenge([
      {
        scheme: "exact",
        network: NETWORK,
        amount: "5000",
        asset: ASSET,
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 300,
      },
    ]);
    const header = await buildPaymentHeader(account, challenge, { expectedNetwork: NETWORK });
    const auth = JSON.parse(atob(header)).payload.authorization;
    const signature = JSON.parse(atob(header)).payload.signature as `0x${string}`;
    const asset = getDefaultAsset(NETWORK);

    const TWA = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as const;
    const message = {
      from: getAddress(auth.from),
      to: getAddress(auth.to),
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce as `0x${string}`,
    };

    // Correct domain -> recovers the payer.
    expect(
      await verifyTypedData({
        address: account.address,
        domain: {
          name: asset.name,
          version: asset.version,
          chainId: chainIdFromCaip2(NETWORK),
          verifyingContract: getAddress(ASSET),
        },
        types: TWA,
        primaryType: "TransferWithAuthorization",
        message,
        signature,
      }),
    ).toBe(true);

    // Wrong chainId -> does NOT verify (proves the signature is domain-bound, not just shaped right).
    expect(
      await verifyTypedData({
        address: account.address,
        domain: {
          name: asset.name,
          version: asset.version,
          chainId: chainIdFromCaip2(NETWORK) + 1,
          verifyingContract: getAddress(ASSET),
        },
        types: TWA,
        primaryType: "TransferWithAuthorization",
        message,
        signature,
      }),
    ).toBe(false);
  });

  it("throws a typed invalid_challenge when no acceptable requirement is present", async () => {
    const challenge = encodeChallenge([]);
    await expect(
      buildPaymentHeader(account, challenge, { expectedNetwork: NETWORK }),
    ).rejects.toThrow(/no acceptable/);
    await expect(
      buildPaymentHeader(account, challenge, { expectedNetwork: NETWORK }),
    ).rejects.toMatchObject({ code: "invalid_challenge" });
  });

  function multiTier() {
    return encodeChallenge(
      [1000000, 5000000, 10000000].map((amt) => ({
        scheme: "exact",
        network: NETWORK,
        amount: String(amt),
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
      })),
    );
  }

  it("overrides the template amount with the requested amountAtomic (#6 deposit tiers)", async () => {
    // NB: this exercises the TEMPLATE-OVERRIDE path ({ ...exact[0], amount }) — the first
    // exact entry is the asset/payTo/network template and the amount is overridden, which
    // is why the assertion can't distinguish "matched an advertised tier" from "override".
    const header = await buildPaymentHeader(account, multiTier(), {
      amountAtomic: 5000000,
      expectedNetwork: NETWORK,
    });
    const decoded = JSON.parse(atob(header));
    expect(decoded.payload.authorization.value).toBe("5000000");
  });

  it("throws on an ambiguous multi-tier challenge with no amount", async () => {
    await expect(
      buildPaymentHeader(account, multiTier(), { expectedNetwork: NETWORK }),
    ).rejects.toThrow(/ambiguous/);
    await expect(
      buildPaymentHeader(account, multiTier(), { expectedNetwork: NETWORK }),
    ).rejects.toMatchObject({ code: "invalid_challenge" });
  });

  it("nonceFromIdempotencyKey is deterministic and pins the EIP-3009 nonce (#2)", async () => {
    const n1 = nonceFromIdempotencyKey("write-1");
    const n2 = nonceFromIdempotencyKey("write-1");
    const n3 = nonceFromIdempotencyKey("write-2");
    expect(n1).toBe(n2);
    expect(n1).not.toBe(n3);

    const challenge = encodeChallenge([
      {
        scheme: "exact",
        network: NETWORK,
        amount: "5000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
      },
    ]);
    const header = await buildPaymentHeader(account, challenge, {
      nonce: n1,
      expectedNetwork: NETWORK,
    });
    const decoded = JSON.parse(atob(header));
    expect(decoded.payload.authorization.nonce).toBe(n1);
  });

  it("selects a higher deposit tier ($25) (#6 / T-06)", async () => {
    const tiers = encodeChallenge(
      [1000000, 5000000, 10000000, 25000000, 50000000].map((amt) => ({
        scheme: "exact",
        network: NETWORK,
        amount: String(amt),
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 600,
        extra: { name: "USDC", version: "2" },
      })),
    );
    const header = await buildPaymentHeader(account, tiers, {
      amountAtomic: 25000000,
      expectedNetwork: NETWORK,
    });
    expect(JSON.parse(atob(header)).payload.authorization.value).toBe("25000000");
  });

  it("signs an arbitrary amount against a single-accept $1 challenge (T-07 arbitrary-amount)", async () => {
    // Single-accept challenge advertising $1 (1_000_000 atomic)
    const singleDollar = encodeChallenge([
      {
        scheme: "exact",
        network: NETWORK,
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 300,
      },
    ]);
    // Pass amountAtomic: 20_000_000 ($20) — should synthesize the requirement from the template
    const header = await buildPaymentHeader(account, singleDollar, {
      amountAtomic: 20_000_000,
      expectedNetwork: NETWORK,
    });
    const decoded = JSON.parse(atob(header));
    // The signed authorization.value must reflect the requested $20, not the template's $1
    expect(decoded.payload.authorization.value).toBe("20000000");
  });
});

describe("payment.chainIdFromCaip2 — strict canonical CAIP-2 only", () => {
  it("accepts a canonical eip155 reference", () => {
    expect(chainIdFromCaip2("eip155:8453")).toBe(8453);
    expect(chainIdFromCaip2("eip155:1")).toBe(1);
  });

  it.each([
    ["eip155:0x2105", "hex form"],
    ["eip155:1e3", "scientific notation"],
    ["eip155:01", "leading zero"],
    ["eip155: 8453", "inner whitespace"],
    ["eip155:9007199254740993", "beyond MAX_SAFE_INTEGER"],
    ["eip155:-1", "negative"],
    ["eip155:", "empty reference"],
  ])("rejects non-canonical form %s (%s) with unsupported_network", (network) => {
    expect(() => chainIdFromCaip2(network)).toThrowError(
      expect.objectContaining({ code: "unsupported_network" }),
    );
  });

  it("rejects a non-eip155 namespace with unsupported_network", () => {
    expect(() => chainIdFromCaip2("solana:mainnet")).toThrowError(
      expect.objectContaining({ code: "unsupported_network" }),
    );
    expect(() => chainIdFromCaip2("eip155")).toThrowError(
      expect.objectContaining({ code: "unsupported_network" }),
    );
  });
});

describe("payment challenge taxonomy — malformed/hostile challenges throw typed AgentXError codes", () => {
  const account = privateKeyToAccount(PK);
  const PINNED = { expectedNetwork: NETWORK };

  it("not-base64 header -> invalid_challenge", async () => {
    await expect(buildPaymentHeader(account, "%%%not-base64%%%", PINNED)).rejects.toMatchObject({
      code: "invalid_challenge",
    });
  });

  it("valid base64 of invalid JSON -> invalid_challenge (no raw SyntaxError escape)", async () => {
    await expect(buildPaymentHeader(account, btoa("{nope"), PINNED)).rejects.toMatchObject({
      code: "invalid_challenge",
    });
  });

  it("JSON without an accepts array -> invalid_challenge", async () => {
    const c = btoa(JSON.stringify({ x402Version: 2 }));
    await expect(buildPaymentHeader(account, c, PINNED)).rejects.toMatchObject({
      code: "invalid_challenge",
    });
  });

  it("accepts: [null] -> invalid_challenge (no raw TypeError escape)", async () => {
    const c = btoa(JSON.stringify({ x402Version: 2, accepts: [null] }));
    await expect(buildPaymentHeader(account, c, PINNED)).rejects.toMatchObject({
      code: "invalid_challenge",
    });
  });

  it.each([
    [1],
    ["banana"],
    [2.5],
    [undefined],
  ])("x402Version %s (not the integer 2) -> invalid_challenge", async (version) => {
    const c = btoa(JSON.stringify({ x402Version: version, accepts: [] }));
    await expect(buildPaymentHeader(account, c, PINNED)).rejects.toMatchObject({
      code: "invalid_challenge",
    });
  });

  it("garbage payTo -> invalid_challenge (no raw viem InvalidAddressError escape)", async () => {
    const signer = neverSigner(account.address);
    await expect(
      buildPaymentHeader(signer, challengeWith({ payTo: "not-an-address" }), PINNED),
    ).rejects.toMatchObject({ code: "invalid_challenge" });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it("mixed-case payTo is checksum-NORMALIZED before signing (bytes govern, not case)", async () => {
    // viem's getAddress recomputes the EIP-55 checksum from the hex bytes rather than
    // trusting the challenge's casing — the signed `to` is the canonical checksum form.
    const header = await buildPaymentHeader(
      account,
      challengeWith({ payTo: "0x8Ba1f109551bd432803012645ac136ddd64dbA72" }),
      PINNED,
    );
    expect(JSON.parse(atob(header)).payload.authorization.to).toBe(
      getAddress("0x8ba1f109551bd432803012645ac136ddd64dba72"),
    );
  });

  it("garbage asset -> invalid_challenge", async () => {
    const signer = neverSigner(account.address);
    await expect(
      buildPaymentHeader(signer, challengeWith({ asset: "0xZZ" }), PINNED),
    ).rejects.toMatchObject({ code: "invalid_challenge" });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it("non-digit challenge amount -> invalid_challenge (never reaches BigInt)", async () => {
    const signer = neverSigner(account.address);
    await expect(
      buildPaymentHeader(signer, challengeWith({ amount: "12.5" }), PINNED),
    ).rejects.toMatchObject({ code: "invalid_challenge" });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it("fractional maxTimeoutSeconds -> invalid_challenge (no 'Cannot convert NaN' escape)", async () => {
    await expect(
      buildPaymentHeader(account, challengeWith({ maxTimeoutSeconds: 300.5 }), PINNED),
    ).rejects.toMatchObject({ code: "invalid_challenge" });
  });

  it("negative maxTimeoutSeconds -> invalid_challenge (never signs an already-expired window)", async () => {
    await expect(
      buildPaymentHeader(account, challengeWith({ maxTimeoutSeconds: -5 }), PINNED),
    ).rejects.toMatchObject({ code: "invalid_challenge" });
  });
});

describe("payment safe-by-default pins (money path fails closed without an explicit opt-out)", () => {
  const account = privateKeyToAccount(PK);

  it("buildPaymentHeader without expectedNetwork -> unpinned_network, nothing signed", async () => {
    const signer = neverSigner(account.address);
    await expect(buildPaymentHeader(signer, challengeWith())).rejects.toMatchObject({
      code: "unpinned_network",
    });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it("opts without expectedNetwork (e.g. only amountAtomic) still -> unpinned_network", async () => {
    await expect(
      buildPaymentHeader(account, challengeWith(), { amountAtomic: 5000 }),
    ).rejects.toMatchObject({ code: "unpinned_network" });
  });

  it("allowUnpinnedNetwork: true is the explicit escape hatch — signs the server-declared network", async () => {
    const header = await buildPaymentHeader(account, challengeWith(), {
      allowUnpinnedNetwork: true,
    });
    expect(JSON.parse(atob(header)).payload.authorization.value).toBe("5000");
  });

  it("challengePriceUsd without expectedNetwork -> unpinned_network", () => {
    expect(() => challengePriceUsd(challengeWith())).toThrowError(
      expect.objectContaining({ code: "unpinned_network" }),
    );
  });

  it("challengePriceUsd with allowUnpinnedNetwork: true prices the server-declared challenge", () => {
    expect(
      challengePriceUsd(challengeWith(), undefined, undefined, { allowUnpinnedNetwork: true }),
    ).toBeCloseTo(0.005, 9);
  });

  it("maxAmountAtomic ceiling rejects an over-ceiling challenge BEFORE signing (SpendCapError)", async () => {
    const signer = neverSigner(account.address);
    // A hostile $50,000 challenge against a $10 ceiling.
    await expect(
      buildPaymentHeader(signer, challengeWith({ amount: "50000000000" }), {
        expectedNetwork: NETWORK,
        maxAmountAtomic: 10_000_000n,
      }),
    ).rejects.toMatchObject({ code: "spend_cap_exceeded" });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it("maxAmountAtomic ceiling admits an at-or-under-ceiling challenge", async () => {
    const header = await buildPaymentHeader(account, challengeWith({ amount: "10000000" }), {
      expectedNetwork: NETWORK,
      maxAmountAtomic: 10_000_000n,
    });
    expect(JSON.parse(atob(header)).payload.authorization.value).toBe("10000000");
  });
});

describe("payment EIP-712 domain extra parity (challenge extra vs pinned registry)", () => {
  const account = privateKeyToAccount(PK);

  it("a challenge whose extra.name/version disagrees with the registry -> domain_mismatch (diagnosable, fail-closed)", async () => {
    const signer = neverSigner(account.address);
    await expect(
      buildPaymentHeader(signer, challengeWith({ extra: { name: "Tether USD", version: "7" } }), {
        expectedNetwork: NETWORK,
      }),
    ).rejects.toMatchObject({ code: "domain_mismatch" });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it("a challenge whose extra matches the registry signs normally", async () => {
    const header = await buildPaymentHeader(
      account,
      challengeWith({ extra: { name: "USDC", version: "2" } }),
      { expectedNetwork: NETWORK },
    );
    expect(JSON.parse(atob(header)).payload.authorization.value).toBe("5000");
  });

  it("extra carrying only unrelated keys is ignored", async () => {
    const header = await buildPaymentHeader(
      account,
      challengeWith({ extra: { routerHint: "x" } }),
      { expectedNetwork: NETWORK },
    );
    expect(JSON.parse(atob(header)).payload.authorization.value).toBe("5000");
  });
});

describe("payment amountAtomic forms (number | bigint | string)", () => {
  const account = privateKeyToAccount(PK);
  const PINNED = { expectedNetwork: NETWORK };

  it("rejects an unsafe-integer number with invalid_amount (silent rounding would sign the wrong value)", async () => {
    await expect(
      buildPaymentHeader(account, challengeWith(), { ...PINNED, amountAtomic: 2 ** 53 }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it.each([[-1], [0], [1.5]])("rejects non-positive/fractional number %s", async (amt) => {
    await expect(
      buildPaymentHeader(account, challengeWith(), { ...PINNED, amountAtomic: amt }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it("accepts a bigint beyond Number.MAX_SAFE_INTEGER exactly (18-decimal-asset scale)", async () => {
    const big = 2n ** 53n + 1n; // the exact value a JS number silently rounds
    const header = await buildPaymentHeader(account, challengeWith(), {
      ...PINNED,
      amountAtomic: big,
    });
    expect(JSON.parse(atob(header)).payload.authorization.value).toBe(big.toString());
  });

  it("accepts a digit string and normalizes leading zeros", async () => {
    const header = await buildPaymentHeader(account, challengeWith(), {
      ...PINNED,
      amountAtomic: "007",
    });
    expect(JSON.parse(atob(header)).payload.authorization.value).toBe("7");
  });

  it("rejects a non-digit string with invalid_amount", async () => {
    await expect(
      buildPaymentHeader(account, challengeWith(), { ...PINNED, amountAtomic: "12.5" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });
});

describe("payment.challengePriceUsd", () => {
  it("prices a $0.005 challenge ('5000' atomic at 6 decimals)", () => {
    expect(challengePriceUsd(challengeWith(), undefined, NETWORK)).toBeCloseTo(0.005, 9);
  });

  it("prices the amountAtomic override against a multi-tier challenge", () => {
    const tiers = encodeChallenge(
      [1000000, 5000000].map((amt) => ({
        scheme: "exact",
        network: NETWORK,
        amount: String(amt),
        asset: USDC,
        payTo: PAY_TO,
      })),
    );
    expect(challengePriceUsd(tiers, 25000000, NETWORK)).toBe(25);
  });

  it("throws /ambiguous/ invalid_challenge on multi-tier with no amount", () => {
    const tiers = encodeChallenge(
      [1000000, 5000000].map((amt) => ({
        scheme: "exact",
        network: NETWORK,
        amount: String(amt),
        asset: USDC,
        payTo: PAY_TO,
      })),
    );
    expect(() => challengePriceUsd(tiers, undefined, NETWORK)).toThrow(/ambiguous/);
    expect(() => challengePriceUsd(tiers, undefined, NETWORK)).toThrowError(
      expect.objectContaining({ code: "invalid_challenge" }),
    );
  });

  it("rejects a network mismatch with network_mismatch", () => {
    expect(() =>
      challengePriceUsd(challengeWith({ network: "eip155:42161" }), undefined, NETWORK),
    ).toThrowError(expect.objectContaining({ code: "network_mismatch" }));
  });

  it("rejects a non-canonical asset with asset_mismatch", () => {
    expect(() =>
      challengePriceUsd(
        challengeWith({ asset: "0x00000000000000000000000000000000000000AA" }),
        undefined,
        NETWORK,
      ),
    ).toThrowError(expect.objectContaining({ code: "asset_mismatch" }));
  });

  it.each([
    ["-5000000"],
    ["1e6"],
    ["abc"],
    [" 5000000 "],
    ["0x10"],
  ])("rejects malformed challenge amount %s with invalid_challenge (no NaN/misprice escape)", (amount) => {
    expect(() => challengePriceUsd(challengeWith({ amount }), undefined, NETWORK)).toThrowError(
      expect.objectContaining({ code: "invalid_challenge" }),
    );
  });
});

describe("payment window clamp — MAX_AUTH_WINDOW_SEC is the unconditional bearer-instrument bound", () => {
  const account = privateKeyToAccount(PK);
  afterEach(() => vi.useRealTimers());

  it("MAX_AUTH_WINDOW_SEC is 3600 (widening it widens every signed authorization)", () => {
    expect(MAX_AUTH_WINDOW_SEC).toBe(3600);
  });

  it("clamps a hostile ~10-year maxTimeoutSeconds to exactly now+3600, validAfter 0", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    const header = await buildPaymentHeader(
      account,
      challengeWith({ maxTimeoutSeconds: 315360000 }),
      { expectedNetwork: NETWORK },
    );
    const auth = JSON.parse(atob(header)).payload.authorization;
    expect(auth.validBefore).toBe(String(nowSec() + 3600)); // clamped, not 10 years
    expect(auth.validAfter).toBe("0");
  });

  it("uses the server window when under the cap (default 300s when absent)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    const header = await buildPaymentHeader(
      account,
      challengeWith({ maxTimeoutSeconds: undefined }),
      {
        expectedNetwork: NETWORK,
      },
    );
    const auth = JSON.parse(atob(header)).payload.authorization;
    expect(auth.validBefore).toBe(String(nowSec() + 300));
  });
});

describe("payment pins reject BEFORE signing (cross-chain-drain defenses)", () => {
  const account = privateKeyToAccount(PK);

  it("expectedNetwork mismatch -> network_mismatch and signTypedData is NEVER invoked", async () => {
    const signer = neverSigner(account.address);
    // A Base-configured client handed an Arbitrum challenge (same EOA, different chain's USDC).
    await expect(
      buildPaymentHeader(signer, challengeWith({ network: "eip155:42161" }), {
        expectedNetwork: NETWORK,
      }),
    ).rejects.toMatchObject({ code: "network_mismatch" });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it("matching network but non-canonical asset -> asset_mismatch, never signed", async () => {
    const signer = neverSigner(account.address);
    await expect(
      buildPaymentHeader(
        signer,
        challengeWith({ asset: "0x00000000000000000000000000000000000000AA" }),
        { expectedNetwork: NETWORK },
      ),
    ).rejects.toMatchObject({ code: "asset_mismatch" });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it("expectedPayTo mismatch -> payto_mismatch, never signed", async () => {
    const signer = neverSigner(account.address);
    await expect(
      buildPaymentHeader(signer, challengeWith(), {
        expectedNetwork: NETWORK,
        expectedPayTo: "0x0000000000000000000000000000000000000002",
      }),
    ).rejects.toMatchObject({ code: "payto_mismatch" });
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });

  it("expectedPayTo accepts checksum-vs-lowercase equivalence", async () => {
    // Challenge payTo is lowercase; the pin is the checksummed form of the same address.
    const addr = "0x8ba1f109551bd432803012645ac136ddd64dba72";
    const header = await buildPaymentHeader(account, challengeWith({ payTo: addr }), {
      expectedNetwork: NETWORK,
      expectedPayTo: getAddress(addr),
    });
    expect(JSON.parse(atob(header)).payload.authorization.to).toBe(getAddress(addr));
  });

  it("all pins satisfied -> signs (happy path)", async () => {
    const header = await buildPaymentHeader(account, challengeWith(), {
      expectedNetwork: NETWORK,
      expectedPayTo: PAY_TO,
      maxAmountAtomic: 10_000n,
    });
    expect(JSON.parse(atob(header)).payload.authorization.value).toBe("5000");
  });
});

describe("payment identity-domain literal pins (server parity)", () => {
  it("EIP712_DOMAIN_NAME/VERSION match the server's hardcoded verifier values", () => {
    // The worker hardcodes "AgentKV"/"1" independently — a drift here breaks every identity op.
    expect(EIP712_DOMAIN_NAME).toBe("AgentKV");
    expect(EIP712_DOMAIN_VERSION).toBe("1");
  });
});

describe("payment.decodeBase64Utf8", () => {
  it("round-trips non-ASCII as UTF-8, not Latin-1 (its entire reason to exist)", () => {
    const original = "USD₮ münze — 支払い";
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(original)));
    expect(decodeBase64Utf8(b64)).toBe(original);
  });
});

describe("payment.buildBearerHeaders", () => {
  it("wraps the account key as a Bearer Authorization header", () => {
    expect(buildBearerHeaders("ak_test_123")).toEqual({ Authorization: "Bearer ak_test_123" });
  });
});

describe("idempotency.nonceFromIdempotencyKey binding (cross-service EIP-3009 nonce separation)", () => {
  const FROM = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
  const CONTRACT = USDC;

  it("unbound form stays deterministic and key-sensitive (back-compat)", () => {
    expect(nonceFromIdempotencyKey("write-1")).toBe(nonceFromIdempotencyKey("write-1"));
    expect(nonceFromIdempotencyKey("write-1")).not.toBe(nonceFromIdempotencyKey("write-2"));
  });

  it("the same key with different bindings yields DIFFERENT nonces (no cross-service brick)", () => {
    const base = { from: FROM, chainId: 84532, verifyingContract: CONTRACT };
    const n = nonceFromIdempotencyKey("write-1", base);
    expect(n).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(nonceFromIdempotencyKey("write-1", { ...base, chainId: 8453 })).not.toBe(n);
    expect(
      nonceFromIdempotencyKey("write-1", {
        ...base,
        from: "0x0000000000000000000000000000000000000009",
      }),
    ).not.toBe(n);
    expect(
      nonceFromIdempotencyKey("write-1", {
        ...base,
        verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      }),
    ).not.toBe(n);
    expect(nonceFromIdempotencyKey("write-1", base)).toBe(n); // deterministic
    expect(nonceFromIdempotencyKey("write-1")).not.toBe(n); // bound differs from unbound
  });

  it("address case does not change the bound nonce (checksum-normalized)", () => {
    const a = nonceFromIdempotencyKey("k", {
      from: FROM.toLowerCase(),
      chainId: 84532,
      verifyingContract: CONTRACT.toLowerCase(),
    });
    const b = nonceFromIdempotencyKey("k", {
      from: FROM,
      chainId: 84532,
      verifyingContract: CONTRACT,
    });
    expect(a).toBe(b);
  });
});
