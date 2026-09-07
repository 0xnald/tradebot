import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcConcurrencyLimiter, getGlobalRpcLimiter, resetGlobalRpcLimiter, DEFAULT_ROBINHOOD_RPC_MAX_CONCURRENCY } from "./rpcConcurrencyLimiter.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("never exceeds the configured maximum concurrency", async () => {
  const limiter = new RpcConcurrencyLimiter(2);
  let active = 0;
  let maxObserved = 0;
  const gates = Array.from({ length: 6 }, () => deferred<void>());

  const tasks = gates.map((gate, i) =>
    limiter.run(async () => {
      active += 1;
      maxObserved = Math.max(maxObserved, active);
      await gate.promise;
      active -= 1;
    }),
  );

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(maxObserved, 2); // only 2 of 6 started, despite all being queued immediately

  for (const gate of gates) gate.resolve();
  await Promise.all(tasks);
  assert.ok(maxObserved <= 2);
});

test("services CRITICAL-priority requests before MEDIUM/LOW ones queued earlier", async () => {
  const limiter = new RpcConcurrencyLimiter(1);
  const order: string[] = [];
  const blocker = deferred<void>();

  // Occupy the only slot so everything else queues.
  const holding = limiter.run(async () => {
    await blocker.promise;
  });
  await new Promise((r) => setTimeout(r, 5));

  const low = limiter.run(async () => {
    order.push("low");
  }, "LOW");
  await new Promise((r) => setTimeout(r, 5));
  const medium = limiter.run(async () => {
    order.push("medium");
  }, "MEDIUM");
  await new Promise((r) => setTimeout(r, 5));
  const critical = limiter.run(async () => {
    order.push("critical");
  }, "CRITICAL");

  blocker.resolve();
  await Promise.all([holding, low, medium, critical]);

  assert.deepEqual(order, ["critical", "medium", "low"]); // priority wins over arrival order once queued
});

test("preserves FIFO order within the same priority tier", async () => {
  const limiter = new RpcConcurrencyLimiter(1);
  const order: number[] = [];
  const blocker = deferred<void>();

  const holding = limiter.run(async () => {
    await blocker.promise;
  });
  await new Promise((r) => setTimeout(r, 5));

  const tasks = [1, 2, 3].map((n) => limiter.run(async () => {
    order.push(n);
  }, "MEDIUM"));
  await new Promise((r) => setTimeout(r, 5));

  blocker.resolve();
  await Promise.all([holding, ...tasks]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("snapshot reports active count, max concurrency, and queue depth by priority", async () => {
  const limiter = new RpcConcurrencyLimiter(1);
  const blocker = deferred<void>();
  const holding = limiter.run(async () => {
    await blocker.promise;
  });
  await new Promise((r) => setTimeout(r, 5));

  const queued = limiter.run(async () => {}, "LOW");
  await new Promise((r) => setTimeout(r, 5));

  const snapshot = limiter.snapshot;
  assert.equal(snapshot.active, 1);
  assert.equal(snapshot.maxConcurrency, 1);
  assert.equal(snapshot.queued, 1);
  assert.equal(snapshot.queuedByPriority.LOW, 1);

  blocker.resolve();
  await Promise.all([holding, queued]);
  assert.equal(limiter.snapshot.active, 0);
});

test("setMaxConcurrency immediately admits queued work when raised", async () => {
  const limiter = new RpcConcurrencyLimiter(1);
  const blocker = deferred<void>();
  const holding = limiter.run(async () => {
    await blocker.promise;
  });
  await new Promise((r) => setTimeout(r, 5));

  let secondStarted = false;
  const second = limiter.run(async () => {
    secondStarted = true;
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(secondStarted, false); // still queued — only 1 slot

  limiter.setMaxConcurrency(2);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(secondStarted, true); // admitted immediately without waiting for the first to finish

  blocker.resolve();
  await Promise.all([holding, second]);
});

test("run() rejects when the task throws, and still releases the slot for the next queued task", async () => {
  const limiter = new RpcConcurrencyLimiter(1);
  await assert.rejects(
    limiter.run(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  let ran = false;
  await limiter.run(async () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test("getGlobalRpcLimiter returns a single shared instance", () => {
  resetGlobalRpcLimiter();
  const a = getGlobalRpcLimiter();
  const b = getGlobalRpcLimiter();
  assert.equal(a, b);
});

test("getGlobalRpcLimiter respects ROBINHOOD_RPC_MAX_CONCURRENCY when set", () => {
  resetGlobalRpcLimiter();
  const previous = process.env.ROBINHOOD_RPC_MAX_CONCURRENCY;
  process.env.ROBINHOOD_RPC_MAX_CONCURRENCY = "6";
  try {
    const limiter = getGlobalRpcLimiter();
    assert.equal(limiter.maxConcurrency, 6);
  } finally {
    if (previous === undefined) delete process.env.ROBINHOOD_RPC_MAX_CONCURRENCY;
    else process.env.ROBINHOOD_RPC_MAX_CONCURRENCY = previous;
    resetGlobalRpcLimiter();
  }
});

test("getGlobalRpcLimiter falls back to the documented default for an invalid env value", () => {
  resetGlobalRpcLimiter();
  const previous = process.env.ROBINHOOD_RPC_MAX_CONCURRENCY;
  process.env.ROBINHOOD_RPC_MAX_CONCURRENCY = "not-a-number";
  try {
    const limiter = getGlobalRpcLimiter();
    assert.equal(limiter.maxConcurrency, DEFAULT_ROBINHOOD_RPC_MAX_CONCURRENCY);
  } finally {
    if (previous === undefined) delete process.env.ROBINHOOD_RPC_MAX_CONCURRENCY;
    else process.env.ROBINHOOD_RPC_MAX_CONCURRENCY = previous;
    resetGlobalRpcLimiter();
  }
});
