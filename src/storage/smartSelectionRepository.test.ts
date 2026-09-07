import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmartSelectionRepository, listEvaluationsForSignal } from "./smartSelectionRepository.js";
import type { SmartSelectionResult } from "../types/domain.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scout-alpha-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function result(overrides: Partial<SmartSelectionResult> = {}): SmartSelectionResult {
  return {
    id: "sig1:t1",
    signalId: "sig1",
    chainId: 4663,
    contractAddress: "0xtoken",
    computedAt: new Date().toISOString(),
    decision: "WATCH",
    overallScore: 50,
    confidence: 50,
    confidenceBreakdown: { overallConfidence: 50, components: [] },
    expectedValue: { status: "UNKNOWN", statisticallyValidated: false, notes: [] },
    chaseAssessment: { level: "LOW_CHASE_RISK", evidence: [] },
    scoreBreakdown: [],
    positiveFactors: [],
    negativeFactors: [],
    blockingFactors: [],
    hardBlockers: { blocked: false, reasons: [] },
    dataQuality: { overall: "PARTIAL", fields: [], observedAt: new Date().toISOString() },
    featureSnapshot: {} as any,
    modelVersion: "smart-selection-v1",
    ...overrides,
  };
}

test("never overwrites a previous evaluation — a re-evaluation creates a new record", async () => {
  await withTempDir(async (dir) => {
    const repo = createSmartSelectionRepository(join(dir, "evaluations.ndjson"));
    await repo.save(result({ id: "sig1:t1", overallScore: 40 }));
    await repo.save(result({ id: "sig1:t2", overallScore: 80 })); // re-evaluation, different id

    const all = await repo.list();
    assert.equal(all.length, 2);
  });
});

test("listEvaluationsForSignal returns every evaluation for a signal, oldest first", async () => {
  await withTempDir(async (dir) => {
    const repo = createSmartSelectionRepository(join(dir, "evaluations.ndjson"));
    await repo.save(result({ id: "sig1:t2", computedAt: "2026-09-05T00:02:00.000Z" }));
    await repo.save(result({ id: "sig1:t1", computedAt: "2026-09-05T00:01:00.000Z" }));
    await repo.save(result({ id: "sig2:t1", signalId: "sig2", computedAt: "2026-09-05T00:01:30.000Z" }));

    const evaluations = await listEvaluationsForSignal(repo, "sig1");
    assert.equal(evaluations.length, 2);
    assert.equal(evaluations[0].id, "sig1:t1"); // oldest first
    assert.equal(evaluations[1].id, "sig1:t2");
  });
});
