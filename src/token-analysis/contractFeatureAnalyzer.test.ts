import { test } from "node:test";
import assert from "node:assert/strict";
import { toFunctionSelector } from "viem";
import { ContractFeatureAnalyzer } from "./contractFeatureAnalyzer.js";

const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";

function fakeChainClient(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  return {
    chainId: 4663,
    getBytecode: overrides.getBytecode ?? (async () => "0x6001600101"),
    getStorageAt: overrides.getStorageAt ?? (async () => "0x" + "0".repeat(64)),
  } as any;
}

function bytecodeWithSelector(signature: string): string {
  // Embed a real, correctly-computed selector inside otherwise-arbitrary bytecode.
  const selector = toFunctionSelector(signature).slice(2);
  return `0x6080604052${selector}600055`;
}

test("returns 'unknown' for every feature when the contract has no bytecode", async () => {
  const analyzer = new ContractFeatureAnalyzer({ chainClient: fakeChainClient({ getBytecode: async () => null }) });
  const result = await analyzer.analyze(TOKEN);

  assert.equal(result.mintFunctionDetected, "unknown");
  assert.equal(result.proxyPatternDetected, "unknown");
  assert.equal(result.bytecodeSizeBytes, null);
});

test("detects a mint function selector present in the bytecode", async () => {
  const analyzer = new ContractFeatureAnalyzer({
    chainClient: fakeChainClient({ getBytecode: async () => bytecodeWithSelector("mint(address,uint256)") }),
  });
  const result = await analyzer.analyze(TOKEN);
  assert.equal(result.mintFunctionDetected, "detected");
});

test("reports 'not_detected' — never a safety claim — when no candidate selector is present", async () => {
  const analyzer = new ContractFeatureAnalyzer({
    chainClient: fakeChainClient({ getBytecode: async () => "0x6080604052600055" }),
  });
  const result = await analyzer.analyze(TOKEN);

  assert.equal(result.mintFunctionDetected, "not_detected");
  assert.equal(result.burnFunctionDetected, "not_detected");
  assert.ok(result.detectionCaveat.length > 0);
});

test("detects ownership-related functions independently of mint", async () => {
  const analyzer = new ContractFeatureAnalyzer({
    chainClient: fakeChainClient({ getBytecode: async () => bytecodeWithSelector("renounceOwnership()") }),
  });
  const result = await analyzer.analyze(TOKEN);
  assert.equal(result.ownershipFunctionDetected, "detected");
  assert.equal(result.mintFunctionDetected, "not_detected");
});

test("detects a non-zero EIP-1967 proxy slot as a proxy pattern", async () => {
  const analyzer = new ContractFeatureAnalyzer({
    chainClient: fakeChainClient({
      getStorageAt: async () => "0x000000000000000000000000abcabcabcabcabcabcabcabcabcabcabcabcab",
    }),
  });
  const result = await analyzer.analyze(TOKEN);
  assert.equal(result.proxyPatternDetected, "detected");
});

test("treats an all-zero storage slot as no proxy detected", async () => {
  const analyzer = new ContractFeatureAnalyzer({ chainClient: fakeChainClient() });
  const result = await analyzer.analyze(TOKEN);
  assert.equal(result.proxyPatternDetected, "not_detected");
});

test("reports bytecode size in bytes", async () => {
  const analyzer = new ContractFeatureAnalyzer({ chainClient: fakeChainClient({ getBytecode: async () => "0x1234" }) });
  const result = await analyzer.analyze(TOKEN);
  assert.equal(result.bytecodeSizeBytes, 2);
});

test("does not throw when getStorageAt fails, and marks proxy detection unknown", async () => {
  const analyzer = new ContractFeatureAnalyzer({
    chainClient: fakeChainClient({
      getStorageAt: async () => {
        throw new Error("rpc error");
      },
    }),
  });
  const result = await analyzer.analyze(TOKEN);
  assert.equal(result.proxyPatternDetected, "unknown");
});
