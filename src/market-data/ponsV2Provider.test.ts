import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, encodeAbiParameters } from "viem";
import { PonsV2Provider } from "./ponsV2Provider.js";

const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";
const PAIR_TOKEN = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // USDG
const CURVE = "0x5d9C26776C0c7d9D512f8891F04f0d61aa87f6DE";
const DEPLOYER = "0x49c5435117Ad5860621BbEaa4B04EEEd4AAA23F4";
const HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const KNOWN_GOOD_POOL_ID = "0x29a9f241f8299f80d4fc533fee32e97a10b4b5d39d52f6b6376e1b596ab2cad3";

function fakeChainClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return {
    chainId: 4663,
    readContract: overrides.readContract ?? (async () => { throw new Error("not stubbed"); }),
    getBlockNumber: overrides.getBlockNumber ?? (async () => 1_000_000n),
    getLogs: overrides.getLogs ?? (async () => []),
    getBlockTimestamp: overrides.getBlockTimestamp ?? (async () => { throw new Error("not stubbed"); }),
  } as any;
}

function struct(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    token: TOKEN,
    curve: CURVE,
    deployer: DEPLOYER,
    creatorFeeRecipient: "0x2eA9967F6E553683D59335Bf6290d817FC380756",
    pairToken: PAIR_TOKEN,
    graduationThreshold: 8_090_000_000n,
    poolFee: 0,
    tickSpacing: 200,
    creatorTaxBps: 0,
    buybackEnabled: false,
    phase: 2, // POOL_CREATED
    sweptQuote: 0n,
    sweptTokens: 0n,
    sweptAt: 0n,
    exists: true,
    ...overrides,
  };
}

test("returns 'unavailable' (not error) when the token was never launched through Pons V2", async () => {
  const provider = new PonsV2Provider({ chainClient: fakeChainClient({ readContract: async () => struct({ exists: false }) }) });
  const result = await provider.getLaunchInfo(TOKEN);
  assert.equal(result.status, "unavailable");
  assert.equal(result.data, null);
  assert.equal(result.errors.length, 0);
});

test("a graduated (POOL_CREATED) launch resolves to the deterministically-computed Uniswap V4 PoolId, verified against a known-real value", async () => {
  const provider = new PonsV2Provider({ chainClient: fakeChainClient({ readContract: async () => struct({ phase: 2 }) }) });
  const result = await provider.getLaunchInfo(TOKEN);

  assert.equal(result.status, "ok");
  assert.equal(result.data?.phase, "POOL_CREATED");
  assert.equal(result.data?.priceIdentifierKind, "V4_POOL_ID");
  assert.equal(result.data?.priceIdentifier.toLowerCase(), KNOWN_GOOD_POOL_ID.toLowerCase());
});

test("a still-on-curve (NOT_GRADUATED) launch resolves to the curve address itself", async () => {
  const provider = new PonsV2Provider({ chainClient: fakeChainClient({ readContract: async () => struct({ phase: 0 }) }) });
  const result = await provider.getLaunchInfo(TOKEN);

  assert.equal(result.data?.phase, "NOT_GRADUATED");
  assert.equal(result.data?.priceIdentifierKind, "CURVE");
  assert.equal(result.data?.priceIdentifier.toLowerCase(), CURVE.toLowerCase());
});

test("a RESCUED launch is also treated as graduated (pool exists)", async () => {
  const provider = new PonsV2Provider({ chainClient: fakeChainClient({ readContract: async () => struct({ phase: 3 }) }) });
  const result = await provider.getLaunchInfo(TOKEN);
  assert.equal(result.data?.priceIdentifierKind, "V4_POOL_ID");
});

test("a SWEPT (intermediate) phase is not yet treated as a resolvable pool", async () => {
  const provider = new PonsV2Provider({ chainClient: fakeChainClient({ readContract: async () => struct({ phase: 1 }) }) });
  const result = await provider.getLaunchInfo(TOKEN);
  assert.equal(result.data?.priceIdentifierKind, "CURVE");
  assert.equal(result.data?.priceIdentifier.toLowerCase(), CURVE.toLowerCase());
});

test("computed PoolId is order-independent — sorts currencies numerically regardless of which is token vs pairToken", async () => {
  // token address here is numerically LOWER than pairToken in the fixture above (token starts 0xeb..., pair 0x5f...)
  // sanity: recompute manually with the documented formula and confirm equality.
  const [currency0, currency1] =
    BigInt(TOKEN) < BigInt(PAIR_TOKEN) ? [TOKEN, PAIR_TOKEN] : [PAIR_TOKEN, TOKEN];
  const expected = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0 as `0x${string}`, currency1 as `0x${string}`, 0, 200, HOOK],
    ),
  );
  assert.equal(expected.toLowerCase(), KNOWN_GOOD_POOL_ID.toLowerCase());
});

test("rejects an invalid token address without calling the chain", async () => {
  let called = false;
  const provider = new PonsV2Provider({
    chainClient: fakeChainClient({
      readContract: async () => {
        called = true;
        return struct();
      },
    }),
  });
  const result = await provider.getLaunchInfo("not-an-address");
  assert.equal(result.status, "error");
  assert.equal(called, false);
});

test("returns a structured error (not a throw) when the chain call fails", async () => {
  const provider = new PonsV2Provider({
    chainClient: fakeChainClient({
      readContract: async () => {
        throw new Error("RPC unreachable");
      },
    }),
  });
  const result = await provider.getLaunchInfo(TOKEN);
  assert.equal(result.status, "error");
  assert.equal(result.data, null);
  assert.match(result.errors[0].message, /RPC unreachable/);
});

test("a graduated launch's graduationTimestamp comes from a real CurveCompleted event, never inferred from phase alone", async () => {
  const graduationBlock = 500_000n;
  const provider = new PonsV2Provider({
    chainClient: fakeChainClient({
      readContract: async () => struct({ phase: 2 }),
      getLogs: async () => [{ blockNumber: graduationBlock }],
      getBlockTimestamp: async (blockNumber: bigint) => (blockNumber === graduationBlock ? "2026-09-04T19:52:32.000Z" : null),
    }),
  });
  const result = await provider.getLaunchInfo(TOKEN);
  assert.equal(result.data?.graduationTimestamp, "2026-09-04T19:52:32.000Z");
});

test("graduationTimestamp is null (not fabricated) when a graduated launch's CurveCompleted event can't be found", async () => {
  const provider = new PonsV2Provider({
    chainClient: fakeChainClient({
      readContract: async () => struct({ phase: 2 }),
      getLogs: async () => [],
    }),
  });
  const result = await provider.getLaunchInfo(TOKEN);
  assert.equal(result.data?.graduationTimestamp, null);
});

test("graduationTimestamp is null for a still-on-curve launch — there is no graduation to find", async () => {
  let getLogsCalled = false;
  const provider = new PonsV2Provider({
    chainClient: fakeChainClient({
      readContract: async () => struct({ phase: 0 }),
      getLogs: async () => {
        getLogsCalled = true;
        return [];
      },
    }),
  });
  const result = await provider.getLaunchInfo(TOKEN);
  assert.equal(result.data?.graduationTimestamp, null);
  assert.equal(getLogsCalled, false); // never even looked — NOT_GRADUATED can't have a CurveCompleted event
});
