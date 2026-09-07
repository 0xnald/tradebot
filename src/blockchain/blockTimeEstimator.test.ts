import { test } from "node:test";
import assert from "node:assert/strict";
import { BlockTimeEstimator } from "./blockTimeEstimator.js";

function fakeChainClient(currentBlock: bigint, blockToTimestamp: Record<string, string>) {
  const calls = { getBlockNumber: 0, getBlockTimestamp: 0 };
  return {
    calls,
    client: {
      getBlockNumber: async () => {
        calls.getBlockNumber += 1;
        return currentBlock;
      },
      getBlockTimestamp: async (blockNumber: bigint) => {
        calls.getBlockTimestamp += 1;
        const ts = blockToTimestamp[blockNumber.toString()];
        if (!ts) throw new Error(`no fixture timestamp for block ${blockNumber}`);
        return ts;
      },
    } as any,
  };
}

test("interpolates a block number linearly between two calibration points", async () => {
  // block 0 = t=0s, block 1_000_000 = t=1_000_000s (1 block/sec model)
  const { client } = fakeChainClient(1_000_000n, {
    "1000000": new Date(1_000_000_000).toISOString(),
    "0": new Date(0).toISOString(),
  });
  const estimator = new BlockTimeEstimator(client);
  const estimated = await estimator.estimateBlockAt(500_000_000); // halfway
  assert.equal(estimated, 500_000n);
});

test("clamps an extrapolated-before-genesis estimate to zero", async () => {
  const { client } = fakeChainClient(1_000_000n, {
    "1000000": new Date(1_000_000_000).toISOString(),
    "0": new Date(0).toISOString(),
  });
  const estimator = new BlockTimeEstimator(client);
  const estimated = await estimator.estimateBlockAt(-1_000_000_000); // before genesis
  assert.equal(estimated, 0n);
});

test("calibrates only once and reuses the model across multiple estimates", async () => {
  const { client, calls } = fakeChainClient(1_000_000n, {
    "1000000": new Date(1_000_000_000).toISOString(),
    "0": new Date(0).toISOString(),
  });
  const estimator = new BlockTimeEstimator(client);
  await estimator.estimateBlockAt(100_000_000);
  await estimator.estimateBlockAt(200_000_000);
  await estimator.estimateBlockAt(300_000_000);
  assert.equal(calls.getBlockNumber, 1);
  assert.equal(calls.getBlockTimestamp, 2); // one for each calibration point (blockA, blockB), fetched only once total
});

test("uses block 0 as the lower calibration bound when the chain is younger than the lookback window", async () => {
  const { client } = fakeChainClient(500n, {
    "500": new Date(500_000).toISOString(),
    "0": new Date(0).toISOString(),
  });
  const estimator = new BlockTimeEstimator(client, 1_000_000n); // lookback wider than chain height
  const estimated = await estimator.estimateBlockAt(250_000);
  assert.equal(estimated, 250n);
});
