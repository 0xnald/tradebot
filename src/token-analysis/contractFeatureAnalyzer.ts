// Bytecode-selector-presence detection for common risk-relevant contract
// functions. This is static evidence, NOT a safety verdict — see the
// ContractFeatureDetection doc comment in src/types/domain.ts and
// docs/TOKEN_MARKET_INTELLIGENCE.md for the full caveat.
//
// Method: compute the real 4-byte selector for each candidate function
// signature with viem's `toFunctionSelector` (keccak256-based — this
// avoids relying on memorized hex constants, which risks silent
// mis-detection if misremembered) and check whether it appears anywhere
// in the contract's deployed bytecode. Selector presence is a strong but
// not certain signal: a matching 4 bytes could theoretically collide, and
// a proxy contract's bytecode won't contain its real implementation's
// selectors at all (see `proxyPatternDetected`).

import { toFunctionSelector, type Address } from "viem";
import type { RobinhoodChainClient } from "../blockchain/robinhoodChainClient.js";
import type { ContractFeatureDetection, FeatureDetectionState } from "../types/domain.js";

/** EIP-1967 implementation storage slot: keccak256("eip1967.proxy.implementation") - 1. */
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bb" as const;

const DETECTION_METHOD = "bytecode-selector-scan";
const DETECTION_CAVEAT =
  "Selector presence in deployed bytecode is evidence, not proof: a proxy contract's own bytecode won't contain its real implementation's selectors (see proxyPatternDetected), and 'not_detected' never means the contract is safe — it only means this specific check found no evidence.";

const SIGNATURE_GROUPS: Record<
  keyof Pick<
    ContractFeatureDetection,
    | "mintFunctionDetected"
    | "burnFunctionDetected"
    | "pauseFunctionDetected"
    | "blacklistFunctionDetected"
    | "ownershipFunctionDetected"
    | "maxTransactionFunctionDetected"
    | "maxWalletFunctionDetected"
    | "feeOrTaxFunctionDetected"
  >,
  string[]
> = {
  mintFunctionDetected: ["mint(address,uint256)", "mint(uint256)"],
  burnFunctionDetected: ["burn(uint256)", "burn(address,uint256)", "burnFrom(address,uint256)"],
  pauseFunctionDetected: ["pause()", "unpause()", "paused()"],
  blacklistFunctionDetected: [
    "blacklist(address)",
    "addBlacklist(address)",
    "setBlacklist(address,bool)",
    "isBlacklisted(address)",
    "blocklist(address)",
  ],
  ownershipFunctionDetected: ["owner()", "renounceOwnership()", "transferOwnership(address)"],
  maxTransactionFunctionDetected: [
    "setMaxTransactionAmount(uint256)",
    "maxTransactionAmount()",
    "_maxTxAmount()",
  ],
  maxWalletFunctionDetected: ["setMaxWalletAmount(uint256)", "maxWalletAmount()", "_maxWalletSize()"],
  feeOrTaxFunctionDetected: [
    "setFees(uint256,uint256)",
    "setTaxes(uint256,uint256)",
    "buyTax()",
    "sellTax()",
    "setBuyTax(uint256)",
    "setSellTax(uint256)",
  ],
};

function bytecodeContainsSelector(bytecode: string, selector: string): boolean {
  // Selectors are "0x" + 8 hex chars; bytecode comparison is case-insensitive.
  return bytecode.toLowerCase().includes(selector.slice(2).toLowerCase());
}

function detectGroup(bytecode: string, signatures: string[]): FeatureDetectionState {
  const found = signatures.some((sig) => bytecodeContainsSelector(bytecode, toFunctionSelector(sig)));
  return found ? "detected" : "not_detected";
}

export interface ContractFeatureAnalyzerOptions {
  chainClient: RobinhoodChainClient;
}

export class ContractFeatureAnalyzer {
  #chainClient: RobinhoodChainClient;

  constructor(options: ContractFeatureAnalyzerOptions) {
    this.#chainClient = options.chainClient;
  }

  async analyze(contractAddress: Address): Promise<ContractFeatureDetection> {
    const observedAt = new Date().toISOString();
    const base = {
      chainId: this.#chainClient.chainId,
      contractAddress,
      observedAt,
      detectionMethod: DETECTION_METHOD,
      detectionCaveat: DETECTION_CAVEAT,
    };

    let bytecode: string | null;
    try {
      bytecode = await this.#chainClient.getBytecode(contractAddress);
    } catch {
      bytecode = null;
    }

    if (!bytecode) {
      return {
        ...base,
        mintFunctionDetected: "unknown",
        burnFunctionDetected: "unknown",
        pauseFunctionDetected: "unknown",
        blacklistFunctionDetected: "unknown",
        ownershipFunctionDetected: "unknown",
        maxTransactionFunctionDetected: "unknown",
        maxWalletFunctionDetected: "unknown",
        feeOrTaxFunctionDetected: "unknown",
        proxyPatternDetected: "unknown",
        bytecodeSizeBytes: null,
      };
    }

    let proxyPatternDetected: FeatureDetectionState = "unknown";
    try {
      const slotValue = await this.#chainClient.getStorageAt(contractAddress, EIP1967_IMPLEMENTATION_SLOT);
      const isZero = !slotValue || /^0x0*$/.test(slotValue);
      proxyPatternDetected = isZero ? "not_detected" : "detected";
    } catch {
      proxyPatternDetected = "unknown";
    }

    return {
      ...base,
      mintFunctionDetected: detectGroup(bytecode, SIGNATURE_GROUPS.mintFunctionDetected),
      burnFunctionDetected: detectGroup(bytecode, SIGNATURE_GROUPS.burnFunctionDetected),
      pauseFunctionDetected: detectGroup(bytecode, SIGNATURE_GROUPS.pauseFunctionDetected),
      blacklistFunctionDetected: detectGroup(bytecode, SIGNATURE_GROUPS.blacklistFunctionDetected),
      ownershipFunctionDetected: detectGroup(bytecode, SIGNATURE_GROUPS.ownershipFunctionDetected),
      maxTransactionFunctionDetected: detectGroup(bytecode, SIGNATURE_GROUPS.maxTransactionFunctionDetected),
      maxWalletFunctionDetected: detectGroup(bytecode, SIGNATURE_GROUPS.maxWalletFunctionDetected),
      feeOrTaxFunctionDetected: detectGroup(bytecode, SIGNATURE_GROUPS.feeOrTaxFunctionDetected),
      proxyPatternDetected,
      bytecodeSizeBytes: (bytecode.length - 2) / 2,
    };
  }
}
