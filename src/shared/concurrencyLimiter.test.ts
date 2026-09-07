import { test } from "node:test";
import assert from "node:assert/strict";
import { ConcurrencyLimiter } from "./concurrencyLimiter.js";

test("never runs more than maxConcurrent tasks at once", async () => {
  const limiter = new ConcurrencyLimiter(2);
  let active = 0;
  let maxObserved = 0;

  const task = () =>
    limiter.run(async () => {
      active += 1;
      maxObserved = Math.max(maxObserved, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });

  await Promise.all([task(), task(), task(), task(), task()]);
  assert.ok(maxObserved <= 2, `expected max 2 concurrent, saw ${maxObserved}`);
});

test("map preserves result order regardless of completion order", async () => {
  const limiter = new ConcurrencyLimiter(2);
  const delays = [30, 10, 20, 5];

  const results = await limiter.map(delays, async (delay, index) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return index;
  });

  assert.deepEqual(results, [0, 1, 2, 3]);
});

test("propagates a task's rejection without hanging the limiter", async () => {
  const limiter = new ConcurrencyLimiter(1);
  await assert.rejects(() => limiter.run(async () => { throw new Error("boom"); }), /boom/);
  // limiter should still work after a rejection
  assert.equal(await limiter.run(async () => 42), 42);
});

test("rejects a non-positive concurrency limit", () => {
  assert.throws(() => new ConcurrencyLimiter(0));
});
