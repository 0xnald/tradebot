// Phase 7.3 §1 — propagates the current Scout signal's id across the
// async call chain (Scout signal -> intelligence gathering -> individual
// RPC calls) WITHOUT threading a `signalId` parameter through every
// intermediate function signature (resolveMarketContextOnce, the Pons/V4
// readers, TokenAnalysisService, ContractFeatureAnalyzer, DeployerAnalyzer
// all stay unchanged). Node's built-in AsyncLocalStorage is the standard
// tool for exactly this: a value implicitly available to everything
// awaited underneath one entry point, never explicit function-signature
// plumbing. Falls back to `null` outside any signal context (e.g. a unit
// test, or a call made before ingestion starts) — recorded as such, never
// guessed.

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();

/** Runs `fn` with `signalId` available to every RPC call instrumented underneath it, however deep. */
export function runWithSignalContext<T>(signalId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run(signalId, fn);
}

/** The current signal's id, or null if called outside any `runWithSignalContext` (never fabricated). */
export function getCurrentSignalId(): string | null {
  return storage.getStore() ?? null;
}
