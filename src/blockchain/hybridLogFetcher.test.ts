import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchLogsHybrid, type LogCapableClient } from "./hybridLogFetcher.js";
import type { RpcProviderCapabilities } from "./chainConfig.js";

const CAPPED_AT_10: RpcProviderCapabilities = { maxGetLogsBlockRange: 10, supportsLargeGetLogs: false };

function fakeClient(impl: (fromBlock: bigint, toBlock: bigint) => Promise<any[]>): LogCapableClient & { callCount: number; calls: Array<[bigint, bigint]> } {
  const calls: Array<[bigint, bigint]> = [];
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    calls,
    async getLogs(params: any) {
      callCount += 1;
      calls.push([params.fromBlock, params.toBlock]);
      return impl(params.fromBlock, params.toBlock);
    },
  };
}

const FAKE_EVENT = { type: "event", name: "Fake", inputs: [] } as const;

test("a small range is served entirely by the primary client — log client never called", async () => {
  const primary = fakeClient(async (from) => [{ blockNumber: from, logIndex: 0 }]);
  const log = fakeClient(async () => {
    throw new Error("log client should not have been called");
  });
  const outcome = await fetchLogsHybrid({ primary, log }, { address: "0xabc", event: FAKE_EVENT, fromBlock: 0n, toBlock: 9n }, { purpose: "PONS_CURVE_FLOW", primaryCapabilities: CAPPED_AT_10 });
  assert.equal(outcome.status, "OK");
  assert.equal(outcome.providerRole, "PRIMARY");
  assert.equal(primary.callCount, 1);
  assert.equal(log.callCount, 0);
});

test("a large range is routed directly to the log client — primary is never even attempted (no predictable-rejection-first pattern)", async () => {
  const primary = fakeClient(async () => {
    throw new Error("primary client should not have been called for a large range");
  });
  const log = fakeClient(async (from) => [{ blockNumber: from, logIndex: 0 }]);
  const outcome = await fetchLogsHybrid({ primary, log }, { address: "0xabc", event: FAKE_EVENT, fromBlock: 0n, toBlock: 100_000n }, { purpose: "PONS_CURVE_FLOW", primaryCapabilities: CAPPED_AT_10 });
  assert.equal(outcome.status, "OK");
  assert.equal(outcome.providerRole, "LOG");
  assert.equal(primary.callCount, 0);
  assert.equal(log.callCount, 1);
});

test("a log-provider failure reports a structured FAILED outcome and does NOT fall back to the incompatible primary", async () => {
  const primary = fakeClient(async () => {
    throw new Error("primary must never be tried as a fallback for a range it cannot serve");
  });
  const log = fakeClient(async () => {
    throw new Error("connection reset");
  });
  const outcome = await fetchLogsHybrid({ primary, log }, { address: "0xabc", event: FAKE_EVENT, fromBlock: 0n, toBlock: 100_000n }, { purpose: "UNISWAP_V4_FLOW", primaryCapabilities: CAPPED_AT_10 });
  assert.equal(outcome.status, "FAILED");
  assert.equal(outcome.providerRole, "LOG");
  assert.equal(outcome.data.length, 0);
  assert.equal(primary.callCount, 0, "primary must never be invoked as a fallback");
});

test("a timeout-classified log failure reports TIMED_OUT", async () => {
  const primary = fakeClient(async () => []);
  const log = fakeClient(async () => {
    throw new Error("request timed out after 15000ms");
  });
  const outcome = await fetchLogsHybrid({ primary, log }, { address: "0xabc", event: FAKE_EVENT, fromBlock: 0n, toBlock: 100_000n }, { purpose: "PONS_CURVE_FLOW", primaryCapabilities: CAPPED_AT_10 });
  assert.equal(outcome.status, "TIMED_OUT");
});

test("a rate-limit-classified log failure reports RATE_LIMITED", async () => {
  const primary = fakeClient(async () => []);
  const log = fakeClient(async () => {
    throw new Error("429 Too Many Requests");
  });
  const outcome = await fetchLogsHybrid({ primary, log }, { address: "0xabc", event: FAKE_EVENT, fromBlock: 0n, toBlock: 100_000n }, { purpose: "PONS_CURVE_FLOW", primaryCapabilities: CAPPED_AT_10 });
  assert.equal(outcome.status, "RATE_LIMITED");
});

test("the same semantic query returns the same shape of result regardless of which provider actually served it", async () => {
  const sameLogs = [{ blockNumber: 5n, logIndex: 0 }];
  const primary = fakeClient(async () => sameLogs);
  const log = fakeClient(async () => sameLogs);

  const small = await fetchLogsHybrid({ primary, log }, { address: "0xabc", event: FAKE_EVENT, fromBlock: 0n, toBlock: 5n }, { purpose: "PONS_CURVE_FLOW", primaryCapabilities: CAPPED_AT_10 });
  const large = await fetchLogsHybrid({ primary, log }, { address: "0xabc", event: FAKE_EVENT, fromBlock: 0n, toBlock: 5_000_000n }, { purpose: "PONS_CURVE_FLOW", primaryCapabilities: CAPPED_AT_10 });

  assert.equal(small.status, "OK");
  assert.equal(large.status, "OK");
  assert.deepEqual(small.data, large.data);
  assert.notEqual(small.providerRole, large.providerRole); // different transport...
});
