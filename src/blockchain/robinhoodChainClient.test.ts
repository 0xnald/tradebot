import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPublicClient,
  custom,
  encodeFunctionResult,
  numberToHex,
  type PublicClient,
} from "viem";
import { RobinhoodChainClient, isValidAddress } from "./robinhoodChainClient.js";
import { ERC20_ABI } from "./erc20Abi.js";
import { defineRobinhoodChain } from "./chainConfig.js";

const CHAIN_CONFIG = { chainId: 4663, rpcUrl: "http://mock.invalid" };
const TOKEN = "0xeb1898a0d496000506a2799e1b4077776497fd29";
const OWNER = "0x1111111111111111111111111111111111111111";
const NO_CODE_TOKEN = "0x2222222222222222222222222222222222222222";

type RpcHandler = (params: unknown[]) => unknown;

function buildMockClient(handlers: Record<string, RpcHandler>): PublicClient {
  return createPublicClient({
    chain: defineRobinhoodChain(CHAIN_CONFIG),
    transport: custom({
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        const handler = handlers[method];
        if (!handler) {
          throw new Error(`unmocked RPC method in test: ${method}`);
        }
        return handler(params);
      },
    }),
  }) as PublicClient;
}

function selector(data: string): string {
  return data.slice(0, 10);
}

test("getBlockNumber returns the mocked block height", async () => {
  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({
      eth_blockNumber: () => numberToHex(54_901_153n),
    }),
  });

  assert.equal(await client.getBlockNumber(), 54_901_153n);
});

test("getNativeBalance reads eth_getBalance", async () => {
  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({
      eth_getBalance: () => numberToHex(1_500_000_000_000_000_000n),
    }),
  });

  assert.equal(await client.getNativeBalance(OWNER), 1_500_000_000_000_000_000n);
});

test("getTokenBalance decodes an ERC20 balanceOf call", async () => {
  const encoded = encodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    result: 42_000_000_000_000_000_000n,
  });

  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({
      eth_call: ([{ data }]: any) => {
        assert.equal(selector(data), "0x70a08231"); // balanceOf(address)
        return encoded;
      },
    }),
  });

  assert.equal(await client.getTokenBalance(TOKEN, OWNER), 42_000_000_000_000_000_000n);
});

test("getTokenMetadata reads name/symbol/decimals/totalSupply", async () => {
  const responses: Record<string, string> = {
    "0x06fdde03": encodeFunctionResult({ abi: ERC20_ABI, functionName: "name", result: "Throbbin" }),
    "0x95d89b41": encodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", result: "THROBBIN" }),
    "0x313ce567": encodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", result: 18 }),
    "0x18160ddd": encodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "totalSupply",
      result: 1_000_000_000_000_000_000_000_000n,
    }),
  };

  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({
      eth_call: ([{ data }]: any) => {
        const response = responses[selector(data)];
        if (!response) throw new Error(`unmocked selector ${selector(data)}`);
        return response;
      },
    }),
  });

  const metadata = await client.getTokenMetadata(TOKEN);
  assert.deepEqual(metadata, {
    name: "Throbbin",
    symbol: "THROBBIN",
    decimals: 18,
    totalSupplyRaw: "1000000000000000000000000",
  });
});

test("getTokenMetadata tolerates one reverting field without failing the others", async () => {
  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({
      eth_call: ([{ data }]: any) => {
        if (selector(data) === "0x06fdde03") throw new Error("execution reverted");
        if (selector(data) === "0x95d89b41") {
          return encodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", result: "NONAME" });
        }
        if (selector(data) === "0x313ce567") {
          return encodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", result: 9 });
        }
        if (selector(data) === "0x18160ddd") {
          return encodeFunctionResult({ abi: ERC20_ABI, functionName: "totalSupply", result: 1n });
        }
        throw new Error("unexpected selector");
      },
    }),
  });

  const metadata = await client.getTokenMetadata(TOKEN);
  assert.equal(metadata.name, null);
  assert.equal(metadata.symbol, "NONAME");
  assert.equal(metadata.decimals, 9);
});

test("getBlockTimestamp converts a block's unix timestamp to ISO 8601", async () => {
  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({
      eth_getBlockByNumber: () => ({
        number: numberToHex(500n),
        hash: "0x" + "1".repeat(64),
        parentHash: "0x" + "1".repeat(64),
        timestamp: numberToHex(1780000000n),
        transactions: [],
      }),
    }),
  });

  assert.equal(await client.getBlockTimestamp(500n), new Date(1780000000 * 1000).toISOString());
});

test("getBytecode returns the deployed code for a contract address", async () => {
  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({ eth_getCode: () => "0x6001600101" }),
  });
  assert.equal(await client.getBytecode(TOKEN), "0x6001600101");
});

test("getBytecode returns null (not '0x') for a non-contract address", async () => {
  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({ eth_getCode: () => "0x" }),
  });
  assert.equal(await client.getBytecode(NO_CODE_TOKEN), null);
});

test("getStorageAt returns the raw slot value", async () => {
  const slotValue = "0x000000000000000000000000abcabcabcabcabcabcabcabcabcabcabcabcab";
  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({ eth_getStorageAt: () => slotValue }),
  });
  assert.equal(
    await client.getStorageAt(TOKEN, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bb"),
    slotValue,
  );
});

test("isValidAddress rejects malformed addresses without throwing", () => {
  assert.equal(isValidAddress(TOKEN), true);
  assert.equal(isValidAddress("not-an-address"), false);
  assert.equal(isValidAddress("0x123"), false);
});

test("findContractDeploymentBlock binary-searches eth_getCode to find the first block with code", async () => {
  const DEPLOYMENT_BLOCK = 1000n;
  const LATEST = 4000n;

  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({
      eth_blockNumber: () => numberToHex(LATEST),
      eth_getCode: ([, blockTag]: any) => {
        const block = blockTag === "latest" ? LATEST : BigInt(blockTag);
        return block >= DEPLOYMENT_BLOCK ? "0x6001600101" : "0x";
      },
    }),
  });

  const result = await client.findContractDeploymentBlock(TOKEN);
  assert.equal(result, Number(DEPLOYMENT_BLOCK));
});

test("findContractDeploymentBlock tolerates a real RPC error at block 0 (live finding: public RPC rejects eth_getCode at genesis)", async () => {
  const DEPLOYMENT_BLOCK = 1000n;
  const LATEST = 4000n;

  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({
      eth_blockNumber: () => numberToHex(LATEST),
      eth_getCode: ([, blockTag]: any) => {
        if (blockTag === "0x0") {
          throw new Error('Missing or invalid parameters. Details: metadata is not found, 3');
        }
        const block = blockTag === "latest" ? LATEST : BigInt(blockTag);
        return block >= DEPLOYMENT_BLOCK ? "0x6001600101" : "0x";
      },
    }),
  });

  const result = await client.findContractDeploymentBlock(TOKEN);
  assert.equal(result, Number(DEPLOYMENT_BLOCK));
});

test("findContractDeploymentBlock returns null for an address with no code", async () => {
  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({
      eth_getCode: () => "0x",
    }),
  });

  assert.equal(await client.findContractDeploymentBlock(NO_CODE_TOKEN), null);
});

test("getContractCreationInfo finds the deployer by scanning the deployment block's creation tx", async () => {
  const DEPLOYMENT_BLOCK = 42n;
  const CREATION_TX_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const OTHER_TX_HASH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const DEPLOYER = "0x3333333333333333333333333333333333333333";
  const TIMESTAMP = 1780000000n;
  const filler64 = "1111111111111111111111111111111111111111111111111111111111111111".slice(0, 64);

  const baseTx = {
    blockHash: "0x" + filler64,
    blockNumber: numberToHex(DEPLOYMENT_BLOCK),
    gas: "0x5208",
    gasPrice: "0x1",
    input: "0x",
    nonce: "0x0",
    transactionIndex: "0x0",
    value: "0x0",
    type: "0x0",
    v: "0x1",
    r: "0x" + filler64,
    s: "0x" + filler64,
    chainId: numberToHex(4663n),
  };

  const client = new RobinhoodChainClient({
    config: CHAIN_CONFIG,
    client: buildMockClient({
      eth_blockNumber: () => numberToHex(DEPLOYMENT_BLOCK + 100n),
      eth_getCode: ([, blockTag]: any) => {
        const block = blockTag === "latest" ? DEPLOYMENT_BLOCK + 100n : BigInt(blockTag);
        return block >= DEPLOYMENT_BLOCK ? "0x6001600101" : "0x";
      },
      eth_getBlockByNumber: () => ({
        number: numberToHex(DEPLOYMENT_BLOCK),
        hash: "0x" + filler64,
        parentHash: "0x" + filler64,
        timestamp: numberToHex(TIMESTAMP),
        transactions: [
          { ...baseTx, hash: OTHER_TX_HASH, from: DEPLOYER, to: OWNER, transactionIndex: "0x0" },
          { ...baseTx, hash: CREATION_TX_HASH, from: DEPLOYER, to: null, transactionIndex: "0x1" },
        ],
      }),
      eth_getTransactionReceipt: ([hash]: any) => ({
        transactionHash: hash,
        blockHash: "0x" + filler64,
        blockNumber: numberToHex(DEPLOYMENT_BLOCK),
        from: DEPLOYER,
        to: hash === CREATION_TX_HASH ? null : OWNER,
        contractAddress: hash === CREATION_TX_HASH ? TOKEN : null,
        cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208",
        logs: [],
        logsBloom: "0x" + "0".repeat(512),
        status: "0x1",
        transactionIndex: hash === CREATION_TX_HASH ? "0x1" : "0x0",
        type: "0x0",
      }),
    }),
  });

  const info = await client.getContractCreationInfo(TOKEN);
  assert.ok(info);
  assert.equal(info?.deploymentBlock, Number(DEPLOYMENT_BLOCK));
  assert.equal(info?.deployerAddress?.toLowerCase(), DEPLOYER.toLowerCase());
  assert.equal(info?.creationTxHash, CREATION_TX_HASH);
  assert.equal(info?.deploymentTimestamp, new Date(Number(TIMESTAMP) * 1000).toISOString());
});
