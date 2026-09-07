import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiquiditySnapshotRepository, getRecentLiquiditySnapshots } from "./liquiditySnapshotRepository.js";
import type { LiquiditySnapshot } from "../types/domain.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scout-alpha-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function snapshot(observedAt: string, liquidityUsd: number | null, poolAddress = "0xpool"): LiquiditySnapshot {
  return { chainId: 4663, poolAddress, observedAt, liquidityUsd, source: "test" };
}

test("stores every snapshot as a distinct historical record, never overwriting", async () => {
  await withTempDir(async (dir) => {
    const repo = createLiquiditySnapshotRepository(join(dir, "liquidity.ndjson"));
    await repo.save(snapshot("2026-09-05T00:00:00.000Z", 100));
    await repo.save(snapshot("2026-09-05T00:01:00.000Z", 110));
    assert.equal((await repo.list()).length, 2);
  });
});

test("getRecentLiquiditySnapshots returns the N most recent, newest first, scoped to one pool", async () => {
  await withTempDir(async (dir) => {
    const repo = createLiquiditySnapshotRepository(join(dir, "liquidity.ndjson"));
    await repo.save(snapshot("2026-09-05T00:00:00.000Z", 100, "0xpoolA"));
    await repo.save(snapshot("2026-09-05T00:01:00.000Z", 110, "0xpoolA"));
    await repo.save(snapshot("2026-09-05T00:02:00.000Z", 120, "0xpoolA"));
    await repo.save(snapshot("2026-09-05T00:03:00.000Z", 999, "0xpoolB")); // different pool — must be excluded

    const recent = await getRecentLiquiditySnapshots(repo, 4663, "0xpoolA", 2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].liquidityUsd, 120); // most recent first
    assert.equal(recent[1].liquidityUsd, 110);
  });
});
