import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSignalMarketSnapshotRepository } from "./signalMarketSnapshotRepository.js";
import type { SignalMarketSnapshot } from "../types/domain.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scout-alpha-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function snapshot(overrides: Partial<SignalMarketSnapshot> = {}): SignalMarketSnapshot {
  return {
    signalId: "sig1",
    chainId: 4663,
    contractAddress: "0xtoken",
    capturedAt: new Date().toISOString(),
    priceUsd: 1,
    liquidityUsd: 1000,
    volumeUsd24h: 500,
    marketCapUsd: null,
    pools: [],
    recentFlow: null,
    tokenAge: null,
    holderInfo: null,
    dataQuality: { overall: "PARTIAL", fields: [], observedAt: new Date().toISOString() },
    ...overrides,
  };
}

test("preserves the first snapshot for a signal and ignores a later attempt to re-record it", async () => {
  await withTempDir(async (dir) => {
    const repo = createSignalMarketSnapshotRepository(join(dir, "snapshots.ndjson"));
    await repo.save(snapshot({ priceUsd: 1 }));
    await repo.save(snapshot({ priceUsd: 999 })); // same signalId — must not overwrite the original

    const stored = await repo.get("sig1");
    assert.equal(stored?.priceUsd, 1);
    assert.equal((await repo.list()).length, 1);
  });
});

test("stores independent snapshots for different signals", async () => {
  await withTempDir(async (dir) => {
    const repo = createSignalMarketSnapshotRepository(join(dir, "snapshots.ndjson"));
    await repo.save(snapshot({ signalId: "sig1" }));
    await repo.save(snapshot({ signalId: "sig2" }));
    assert.equal((await repo.list()).length, 2);
  });
});
