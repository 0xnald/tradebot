import { test } from "node:test";
import assert from "node:assert/strict";
import { BlockTimestampResolver } from "./blockTimestampResolver.js";

function fakeChainClient(impl: (blockNumber: bigint) => Promise<string>) {
  const counter = { count: 0 };
  const client = {
    getBlockTimestamp: async (blockNumber: bigint) => {
      counter.count += 1;
      return impl(blockNumber);
    },
  } as any;
  return { client, counter };
}

test("resolves a block's timestamp", async () => {
  const { client } = fakeChainClient(async () => "2026-09-04T20:00:00.000Z");
  const resolver = new BlockTimestampResolver(client);
  assert.equal(await resolver.resolve(123n), "2026-09-04T20:00:00.000Z");
});

test("caches repeated lookups of the same block — only one RPC call", async () => {
  const { client, counter } = fakeChainClient(async () => "2026-09-04T20:00:00.000Z");
  const resolver = new BlockTimestampResolver(client);
  await resolver.resolve(123n);
  await resolver.resolve(123n);
  await resolver.resolve(123n);
  assert.equal(counter.count, 1);
  assert.equal(resolver.cacheSize, 1);
});

test("dedupes concurrent in-flight lookups of the same block", async () => {
  let resolveFn: (v: string) => void;
  const inFlight = new Promise<string>((resolve) => {
    resolveFn = resolve;
  });
  const { client, counter } = fakeChainClient(() => inFlight);
  const resolver = new BlockTimestampResolver(client);

  const p1 = resolver.resolve(123n);
  const p2 = resolver.resolve(123n);
  resolveFn!("2026-09-04T20:00:00.000Z");

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, "2026-09-04T20:00:00.000Z");
  assert.equal(r2, "2026-09-04T20:00:00.000Z");
  assert.equal(counter.count, 1);
});

test("caches different blocks independently", async () => {
  const { client, counter } = fakeChainClient(async (n) => `ts-${n}`);
  const resolver = new BlockTimestampResolver(client);
  assert.equal(await resolver.resolve(1n), "ts-1");
  assert.equal(await resolver.resolve(2n), "ts-2");
  assert.equal(await resolver.resolve(1n), "ts-1");
  assert.equal(counter.count, 2);
  assert.equal(resolver.cacheSize, 2);
});
