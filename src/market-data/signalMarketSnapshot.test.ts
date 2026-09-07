import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignalMarketSnapshot } from "./signalMarketSnapshot.js";
import type { ProviderResult, TokenMarketData, HolderDistribution } from "../types/domain.js";

const CHAIN_ID = 4663;
const TOKEN = "0xtoken";

function marketDataResult(overrides: Partial<TokenMarketData> = {}): ProviderResult<TokenMarketData> {
  return {
    status: "ok",
    data: {
      chainId: CHAIN_ID,
      contractAddress: TOKEN,
      observedAt: new Date().toISOString(),
      priceUsd: 1,
      marketCapUsd: 100_000,
      liquidityUsd: 50_000,
      volumeUsd24h: 10_000,
      pools: [],
      source: "test",
      ...overrides,
    },
    unavailable: [],
    errors: [],
  };
}

function unavailableResult<T>(): ProviderResult<T> {
  return { status: "unavailable", data: null, unavailable: [], errors: [] };
}

test("captures known market fields with dataQuality KNOWN for each", () => {
  const snapshot = buildSignalMarketSnapshot({
    signalId: "sig1",
    chainId: CHAIN_ID,
    contractAddress: TOKEN,
    marketData: marketDataResult(),
    holderInfo: unavailableResult<HolderDistribution>(),
    tokenAge: { deployedAt: "2026-09-01T00:00:00.000Z", ageSeconds: 3600, ageMinutes: 60, ageHours: 1, ageCategory: "NEW" },
    recentFlow: null,
  });

  assert.equal(snapshot.priceUsd, 1);
  assert.equal(snapshot.marketCapUsd, 100_000);
  assert.equal(snapshot.dataQuality.fields.find((f) => f.field === "priceUsd")?.state, "KNOWN");
  assert.equal(snapshot.dataQuality.fields.find((f) => f.field === "tokenAge")?.state, "KNOWN");
});

test("marks holderInfo UNAVAILABLE (never fabricated) when the provider had none", () => {
  const snapshot = buildSignalMarketSnapshot({
    signalId: "sig1",
    chainId: CHAIN_ID,
    contractAddress: TOKEN,
    marketData: marketDataResult(),
    holderInfo: unavailableResult<HolderDistribution>(),
    tokenAge: null,
    recentFlow: null,
  });

  assert.equal(snapshot.holderInfo, null);
  assert.equal(snapshot.dataQuality.fields.find((f) => f.field === "holderInfo")?.state, "UNAVAILABLE");
  assert.equal(snapshot.dataQuality.overall, "PARTIAL"); // some known (price etc.), some not (holders)
});

test("never fabricates marketCapUsd as 0 when the provider had none", () => {
  const snapshot = buildSignalMarketSnapshot({
    signalId: "sig1",
    chainId: CHAIN_ID,
    contractAddress: TOKEN,
    marketData: marketDataResult({ marketCapUsd: null, marketCapUnavailableReason: "no provider figure" }),
    holderInfo: unavailableResult<HolderDistribution>(),
    tokenAge: null,
    recentFlow: null,
  });

  assert.equal(snapshot.marketCapUsd, null);
  const field = snapshot.dataQuality.fields.find((f) => f.field === "marketCapUsd");
  assert.equal(field?.state, "UNAVAILABLE");
  assert.equal(field?.reason, "no provider figure");
});

test("does not mutate or reference the original ScoutSignal object", () => {
  const snapshot = buildSignalMarketSnapshot({
    signalId: "sig1",
    chainId: CHAIN_ID,
    contractAddress: TOKEN,
    marketData: marketDataResult(),
    holderInfo: unavailableResult<HolderDistribution>(),
    tokenAge: null,
    recentFlow: null,
  });

  assert.ok(!("rawText" in snapshot));
  assert.ok(!("parseConfidence" in snapshot));
});
