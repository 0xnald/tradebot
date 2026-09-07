import { test } from "node:test";
import assert from "node:assert/strict";
import { BlockscoutHolderDataProvider } from "./blockscoutHolderDataProvider.js";

const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";
const DEPLOYER = "0xDeAdBeEf00000000000000000000000000000001";

function withMockFetch<T>(impl: (url: string) => Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => impl(url.toString())) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function tokenInfoResponse() {
  return new Response(JSON.stringify({ holders_count: "3", total_supply: "1000", decimals: "18" }), { status: 200 });
}

function holdersResponse() {
  return new Response(
    JSON.stringify({
      items: [
        { address: { hash: DEPLOYER }, value: "500" },
        { address: { hash: "0xB1" }, value: "300" },
        { address: { hash: "0xC1" }, value: "200" },
      ],
    }),
    { status: 200 },
  );
}

test("combines token info and holders list into a full HolderDistribution", async () => {
  const provider = new BlockscoutHolderDataProvider();
  const result = await withMockFetch(
    (url) => (url.includes("/holders") ? holdersResponse() : tokenInfoResponse()),
    () => provider.getHolderDistribution(4663, TOKEN),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.data?.totalHolders, 3);
  assert.equal(result.data?.topHolders.length, 3);
  assert.equal(result.data?.topHolderConcentrationPct, 100); // 500+300+200 == total supply of 1000
});

test("finds and reports the deployer's own holding when present", async () => {
  const provider = new BlockscoutHolderDataProvider();
  const result = await withMockFetch(
    (url) => (url.includes("/holders") ? holdersResponse() : tokenInfoResponse()),
    () => provider.getHolderDistribution(4663, TOKEN, { deployerAddress: DEPLOYER }),
  );

  assert.equal(result.data?.deployerHolding?.balanceRaw, "500");
  assert.equal(result.data?.deployerHolding?.percentageOfSupply, 50);
});

test("returns 'partial' with totalHolders when only the holders endpoint fails", async () => {
  const provider = new BlockscoutHolderDataProvider();
  const result = await withMockFetch(
    (url) => (url.includes("/holders") ? new Response("blocked", { status: 403 }) : tokenInfoResponse()),
    () => provider.getHolderDistribution(4663, TOKEN),
  );

  assert.equal(result.status, "partial");
  assert.equal(result.data?.totalHolders, 3);
  assert.deepEqual(result.data?.topHolders, []);
  assert.ok(result.unavailable.includes("topHolders"));
});

test("returns 'error' with no fabricated data when both endpoints fail", async () => {
  const provider = new BlockscoutHolderDataProvider();
  const result = await withMockFetch(
    () => new Response("blocked", { status: 403 }),
    () => provider.getHolderDistribution(4663, TOKEN),
  );

  assert.equal(result.status, "error");
  assert.equal(result.data, null);
  assert.equal(result.errors.length, 2);
});

test("rejects an invalid contract address without calling fetch", async () => {
  const provider = new BlockscoutHolderDataProvider();
  let called = false;
  const result = await withMockFetch(
    () => {
      called = true;
      return tokenInfoResponse();
    },
    () => provider.getHolderDistribution(4663, "not-an-address"),
  );

  assert.equal(result.status, "error");
  assert.equal(called, false);
});
