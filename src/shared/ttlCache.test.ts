import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "./ttlCache.js";

test("returns undefined for a missing key", () => {
  const cache = new TtlCache<number>(1000);
  assert.equal(cache.get("missing"), undefined);
});

test("returns a cached value before it expires", () => {
  const cache = new TtlCache<number>(1000);
  cache.set("a", 42);
  assert.equal(cache.get("a"), 42);
});

test("expires a value after its TTL", async () => {
  const cache = new TtlCache<number>(10);
  cache.set("a", 42);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(cache.get("a"), undefined);
});

test("getOrCompute only calls compute once for a cached key", async () => {
  const cache = new TtlCache<number>(1000);
  let calls = 0;
  const compute = async () => {
    calls += 1;
    return 7;
  };

  assert.equal(await cache.getOrCompute("a", compute), 7);
  assert.equal(await cache.getOrCompute("a", compute), 7);
  assert.equal(calls, 1);
});

test("clear removes all entries", () => {
  const cache = new TtlCache<number>(1000);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.clear();
  assert.equal(cache.size, 0);
});
