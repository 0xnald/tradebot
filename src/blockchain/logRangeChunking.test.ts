import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchLogsWithAdaptiveChunking } from "./logRangeChunking.js";

interface FakeLog {
  transactionHash: string;
  logIndex: number;
  blockNumber: bigint;
}

function fakeLog(blockNumber: bigint, logIndex = 0): FakeLog {
  return { transactionHash: `0xtx-${blockNumber}-${logIndex}`, logIndex, blockNumber };
}

test("returns results directly when the full range succeeds — no splitting needed", async () => {
  const calls: Array<[bigint, bigint]> = [];
  const result = await fetchLogsWithAdaptiveChunking(
    async (from, to) => {
      calls.push([from, to]);
      return [fakeLog(from)];
    },
    0n,
    100n,
  );
  assert.deepEqual(result, [fakeLog(0n)]);
  assert.equal(calls.length, 1);
});

test("bisects a failing range on a TOO_MANY_RESULTS-classified error and retries each half", async () => {
  const calls: Array<[bigint, bigint]> = [];
  const result = await fetchLogsWithAdaptiveChunking(
    async (from, to) => {
      calls.push([from, to]);
      if (to - from > 10n) throw new Error("too many results");
      return [fakeLog(from)];
    },
    0n,
    100n,
  );
  assert.ok(result.length > 1);
  assert.ok(calls.some(([f, t]) => t - f > 10n)); // the original wide attempt happened
  assert.ok(calls.some(([f, t]) => t - f <= 10n)); // and it did split down
});

test("recombines results from multiple successful sub-ranges in chronological order", async () => {
  const result = await fetchLogsWithAdaptiveChunking(
    async (from, to) => {
      if (to - from > 25n) throw new Error("too many results");
      return [fakeLog(from)];
    },
    0n,
    100n,
  );
  const blockNumbers = result.map((r) => r.blockNumber);
  const sorted = [...blockNumbers].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(blockNumbers, sorted);
});

test("re-throws the original error once max split depth is exhausted", async () => {
  await assert.rejects(
    () =>
      fetchLogsWithAdaptiveChunking(
        async () => {
          throw new Error("too many results");
        },
        0n,
        1000n,
        2,
      ),
    /too many results/,
  );
});

test("re-throws immediately when a single-block range still fails (not a size problem)", async () => {
  await assert.rejects(
    () =>
      fetchLogsWithAdaptiveChunking(
        async (from, to) => {
          if (to === from) throw new Error("genuinely broken query — too many results anyway");
          throw new Error("too many results");
        },
        5n,
        5n,
      ),
    /genuinely broken query/,
  );
});

test("handles a zero-width range without infinite recursion", async () => {
  const result = await fetchLogsWithAdaptiveChunking(async (from) => [fakeLog(from)], 5n, 5n);
  assert.deepEqual(result, [fakeLog(5n)]);
});

// --- Phase 7.3B §H regression coverage: classification-gated bisection ---

test("a deterministic INVALID_REQUEST error (the exact authenticated-endpoint failure mode) does NOT trigger recursive bisection", async () => {
  let callCount = 0;
  await assert.rejects(
    () =>
      fetchLogsWithAdaptiveChunking(
        async () => {
          callCount++;
          throw new Error("JSON is not a valid request object.");
        },
        0n,
        2_000_000n,
      ),
    /JSON is not a valid request object/,
  );
  // Exactly one attempt — no bisection at all, regardless of how wide the original range was.
  assert.equal(callCount, 1);
});

test("a RANGE_LIMIT-classified error (e.g. Alchemy's real 'up to a 10 block range' rejection) does NOT bisect — halving a million-block range never reaches a 10-block cap", async () => {
  let callCount = 0;
  await assert.rejects(
    () =>
      fetchLogsWithAdaptiveChunking(
        async () => {
          callCount++;
          throw new Error("Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.");
        },
        0n,
        1_000_000n,
      ),
    /10 block range/,
  );
  assert.equal(callCount, 1, "a hard range cap far below any bisection depth must fail on the first attempt, not explode into retries");
});

test("a rate-limit error does not bisect", async () => {
  let callCount = 0;
  await assert.rejects(
    () =>
      fetchLogsWithAdaptiveChunking(
        async () => {
          callCount++;
          throw new Error("429 Too Many Requests");
        },
        0n,
        100n,
      ),
    /429/,
  );
  assert.equal(callCount, 1);
});

test("deduplicates logs by transactionHash+logIndex if a retry path ever returns overlapping results", async () => {
  const duplicate = fakeLog(42n);
  const result = await fetchLogsWithAdaptiveChunking(async () => [duplicate, duplicate, fakeLog(43n)], 0n, 100n);
  assert.equal(result.length, 2);
});
