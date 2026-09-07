import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapChainClientWithRpcControl } from "./instrumentedChainClient.js";
import { getGlobalRpcLimiter, resetGlobalRpcLimiter } from "./rpcConcurrencyLimiter.js";
import { getGlobalRpcCallLog, resetGlobalRpcCallLog } from "./rpcInstrumentation.js";
import { runWithSignalContext } from "../shared/signalContext.js";

function fakeInner(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return {
    chainId: 4663,
    getBlockNumber: overrides.getBlockNumber ?? (async () => 100n),
    getNativeBalance: overrides.getNativeBalance ?? (async () => 0n),
    getTokenBalance: overrides.getTokenBalance ?? (async () => 0n),
    readContract: overrides.readContract ?? (async () => null),
    getTokenMetadata: overrides.getTokenMetadata ?? (async () => ({ name: "T", symbol: "T", decimals: 18, totalSupplyRaw: "1" })),
    getLogs: overrides.getLogs ?? (async () => []),
    getBlockTimestamp: overrides.getBlockTimestamp ?? (async () => "2026-01-01T00:00:00.000Z"),
    getBytecode: overrides.getBytecode ?? (async () => "0x6080"),
    getStorageAt: overrides.getStorageAt ?? (async () => "0x0"),
    getContractCreationInfo: overrides.getContractCreationInfo ?? (async () => null),
    getTransaction: overrides.getTransaction ?? (async () => ({})),
    getTransactionReceipt: overrides.getTransactionReceipt ?? (async () => ({})),
  } as any;
}

test("routes calls through the global limiter and records them under the given caller/priority", async () => {
  resetGlobalRpcLimiter();
  resetGlobalRpcCallLog();
  const inner = fakeInner();
  const wrapped = wrapChainClientWithRpcControl(inner, { caller: "test-caller", priority: "CRITICAL" });

  await wrapped.getBlockNumber();
  await wrapped.getTokenMetadata("0xabc" as any);

  const records = getGlobalRpcCallLog().getAll();
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.caller === "test-caller"));
  assert.ok(records.every((r) => r.status === "OK"));
  assert.equal(records[0].method, "getBlockNumber");
  assert.equal(records[1].method, "getTokenMetadata");
});

test("tags recorded calls with the current signal id via AsyncLocalStorage, without any explicit parameter", async () => {
  resetGlobalRpcLimiter();
  resetGlobalRpcCallLog();
  const inner = fakeInner();
  const wrapped = wrapChainClientWithRpcControl(inner, { caller: "test-caller", priority: "MEDIUM" });

  await runWithSignalContext("signal-123", async () => {
    await wrapped.getBlockNumber();
  });
  await wrapped.getBlockNumber(); // outside any signal context

  const records = getGlobalRpcCallLog().getAll();
  assert.equal(records[0].signalId, "signal-123");
  assert.equal(records[1].signalId, null);
});

test("records ERROR status and re-throws when the underlying call fails", async () => {
  resetGlobalRpcLimiter();
  resetGlobalRpcCallLog();
  const inner = fakeInner({
    getBytecode: async () => {
      throw new Error("rpc exploded");
    },
  });
  const wrapped = wrapChainClientWithRpcControl(inner, { caller: "test-caller", priority: "LOW" });

  await assert.rejects(wrapped.getBytecode("0xabc" as any), /rpc exploded/);
  const records = getGlobalRpcCallLog().getAll();
  assert.equal(records[0].status, "ERROR");
  assert.equal(records[0].error, "rpc exploded");
});

test("records the block range for getLogs calls", async () => {
  resetGlobalRpcLimiter();
  resetGlobalRpcCallLog();
  const inner = fakeInner();
  const wrapped = wrapChainClientWithRpcControl(inner, { caller: "flow-reader", priority: "CRITICAL" });

  await wrapped.getLogs({ fromBlock: 100n, toBlock: 200n } as any);
  const records = getGlobalRpcCallLog().getAll();
  assert.deepEqual(records[0].blockRange, { fromBlock: "100", toBlock: "200" });
});

test("multiple wrappers around the same underlying client share ONE global limiter, not separate ones", async () => {
  resetGlobalRpcLimiter();
  getGlobalRpcLimiter().setMaxConcurrency(1);
  resetGlobalRpcCallLog();

  let active = 0;
  let maxObserved = 0;
  const slowGetBytecode = async () => {
    active += 1;
    maxObserved = Math.max(maxObserved, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
    return "0x6080";
  };
  const inner = fakeInner({ getBytecode: slowGetBytecode, getStorageAt: slowGetBytecode as any });

  const criticalWrapper = wrapChainClientWithRpcControl(inner, { caller: "critical-caller", priority: "CRITICAL" });
  const lowWrapper = wrapChainClientWithRpcControl(inner, { caller: "low-caller", priority: "LOW" });

  await Promise.all([criticalWrapper.getBytecode("0xa" as any), lowWrapper.getStorageAt("0xb" as any, "0x0" as any)]);

  assert.equal(maxObserved, 1); // the two DIFFERENT wrapper instances still shared one global concurrency cap
});

test("recorded concurrencyAtStart reflects the actual global limiter state, not a per-wrapper count", async () => {
  resetGlobalRpcLimiter();
  getGlobalRpcLimiter().setMaxConcurrency(3);
  resetGlobalRpcCallLog();

  const blockers: (() => void)[] = [];
  const slow = () =>
    new Promise<string>((resolve) => {
      blockers.push(() => resolve("0x6080"));
    });
  const inner = fakeInner({ getBytecode: slow });
  const wrapped = wrapChainClientWithRpcControl(inner, { caller: "c", priority: "MEDIUM" });

  const p1 = wrapped.getBytecode("0xa" as any);
  await new Promise((r) => setTimeout(r, 0)); // let p1 actually acquire and start its task body before p2 begins
  const p2 = wrapped.getBytecode("0xb" as any);
  await new Promise((r) => setTimeout(r, 5));

  for (const resolve of blockers) resolve();
  await Promise.all([p1, p2]);

  const records = getGlobalRpcCallLog().getAll();
  assert.equal(records[0].concurrencyAtStart, 1);
  assert.equal(records[1].concurrencyAtStart, 2);
});
