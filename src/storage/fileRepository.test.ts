import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileRepository } from "./fileRepository.js";
import { createWalletIdentityRepository, walletIdentityId } from "./walletIdentityRepository.js";
import { createWalletActivityRepository, walletTradeId } from "./walletActivityRepository.js";
import { createWalletPerformanceRepository } from "./walletPerformanceRepository.js";
import { createScoutWalletAssociationRepository } from "./scoutWalletAssociationRepository.js";
import type {
  WalletIdentity,
  WalletTrade,
  WalletPerformanceSummary,
  ScoutWalletAssociation,
  WalletPerformanceWindow,
} from "../types/domain.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scout-alpha-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("append mode: save is a no-op for a duplicate id (dedupe on restart)", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "items.ndjson");
    const repo = createFileRepository<{ id: string; value: number }>({
      filePath,
      getId: (item) => item.id,
      mode: "append",
    });

    await repo.save({ id: "a", value: 1 });
    await repo.save({ id: "a", value: 999 }); // should be ignored — "a" already exists
    const items = await repo.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].value, 1);
  });
});

test("append mode persists across repository instances (restart-safe)", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "items.ndjson");
    const repo1 = createFileRepository<{ id: string }>({ filePath, getId: (i) => i.id, mode: "append" });
    await repo1.save({ id: "a" });
    await repo1.save({ id: "b" });

    const repo2 = createFileRepository<{ id: string }>({ filePath, getId: (i) => i.id, mode: "append" });
    assert.equal(await repo2.exists("a"), true);
    assert.equal((await repo2.list()).length, 2);
  });
});

test("upsert mode overwrites an existing id instead of ignoring it", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "items.ndjson");
    const repo = createFileRepository<{ id: string; value: number }>({
      filePath,
      getId: (item) => item.id,
      mode: "upsert",
    });

    await repo.save({ id: "a", value: 1 });
    await repo.save({ id: "a", value: 2 });
    const item = await repo.get("a");
    assert.equal(item?.value, 2);
    assert.equal((await repo.list()).length, 1);
  });
});

const chainId = 4663;

function fakeWindow(): WalletPerformanceWindow {
  return {
    windowLabel: "lifetime",
    computed: false,
    insufficientDataReason: "no trades",
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    openTrades: 0,
    unknownTrades: 0,
    winRatePct: null,
    realizedPnlUsd: null,
    averageRoiPct: null,
    medianRoiPct: null,
    maxRoiPct: null,
    minRoiPct: null,
    averageHoldingSeconds: null,
    medianHoldingSeconds: null,
    averageEntryMarketCapUsd: null,
    medianEntryMarketCapUsd: null,
    averageEntryLiquidityUsd: null,
    uniqueTokenCount: 0,
    uniqueTradingDayCount: 0,
    longestWinStreak: 0,
    longestLossStreak: 0,
  };
}

test("WalletIdentityRepository keys a resolved identity by address, ignoring duplicates", async () => {
  await withTempDir(async (dir) => {
    const repo = createWalletIdentityRepository(join(dir, "identities.ndjson"));
    const identity: WalletIdentity = {
      chainId,
      address: "0xAAAA000000000000000000000000000000AAAA",
      discoverySource: "on-chain-swap",
      discoveredAt: new Date().toISOString(),
      confidence: "high",
      sourceReferences: ["0xtxhash"],
    };

    await repo.save(identity);
    assert.equal(await repo.exists(walletIdentityId(identity)), true);
  });
});

test("WalletIdentityRepository keys an unresolved identity by its evidence, not a fabricated address", async () => {
  await withTempDir(async (dir) => {
    const repo = createWalletIdentityRepository(join(dir, "identities.ndjson"));
    const identity: WalletIdentity = {
      chainId,
      truncatedAddress: "0x3430…c941",
      discoverySource: "scout-message-text",
      discoveredAt: new Date().toISOString(),
      confidence: "unresolved",
      sourceReferences: ["telegram:scoutrobinhood:5114"],
    };

    await repo.save(identity);
    const stored = await repo.get(walletIdentityId(identity));
    assert.equal(stored?.address, undefined);
    assert.equal(stored?.truncatedAddress, "0x3430…c941");
  });
});

test("WalletActivityRepository dedupes the same on-chain trade across repeated ingestion", async () => {
  await withTempDir(async (dir) => {
    const repo = createWalletActivityRepository(join(dir, "activity.ndjson"));
    const trade: WalletTrade = {
      chainId,
      walletAddress: "0xWallet",
      timestamp: new Date().toISOString(),
      blockNumber: 1000,
      transactionHash: "0xtx1",
      tokenAddress: "0xtoken",
      poolAddress: "0xpool",
      direction: "BUY",
      tokenAmountRaw: "-100",
      quoteAmountRaw: "5",
      approxUsdValue: null,
      tokenPriceUsdAtTrade: null,
      liquidityUsdAtTrade: null,
      marketCapUsdAtTrade: null,
      source: "uniswap-v3-onchain",
    };

    await repo.save(trade);
    await repo.save(trade);
    assert.equal((await repo.list()).length, 1);
    assert.equal(await repo.exists(walletTradeId(trade)), true);
  });
});

test("WalletPerformanceRepository keeps only the latest snapshot per wallet", async () => {
  await withTempDir(async (dir) => {
    const repo = createWalletPerformanceRepository(join(dir, "performance.ndjson"));
    const base: WalletPerformanceSummary = {
      chainId,
      walletAddress: "0xWallet",
      computedAt: "2026-09-01T00:00:00.000Z",
      lifetime: fakeWindow(),
      last30d: fakeWindow(),
      last7d: fakeWindow(),
      sampleSizeConfidence: 0,
    };

    await repo.save(base);
    await repo.save({ ...base, computedAt: "2026-09-05T00:00:00.000Z", sampleSizeConfidence: 0.5 });

    const items = await repo.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].sampleSizeConfidence, 0.5);
  });
});

test("ScoutWalletAssociationRepository preserves every association even for unresolved wallets", async () => {
  await withTempDir(async (dir) => {
    const repo = createScoutWalletAssociationRepository(join(dir, "associations.ndjson"));
    const association: ScoutWalletAssociation = {
      id: "telegram:scoutrobinhood:5114:0",
      scoutSignalId: "telegram:scoutrobinhood:5114",
      chainId,
      wallet: {
        chainId,
        truncatedAddress: "0x3430…c941",
        discoverySource: "scout-message-text",
        discoveredAt: new Date().toISOString(),
        confidence: "unresolved",
        sourceReferences: ["telegram:scoutrobinhood:5114"],
      },
      badge: "good",
      amountUsdClaimed: 481,
      associationSource: "scout-message:telegram:scoutrobinhood:5114",
      confidence: "unresolved",
      observedAt: new Date().toISOString(),
      rawEvidence: "✅ $481 · 0x3430…c941",
    };

    await repo.save(association);
    const items = await repo.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].wallet.confidence, "unresolved");
  });
});
