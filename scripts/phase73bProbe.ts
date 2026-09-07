// Phase 7.3B §B/§D — read-only probes only. Never prints the authenticated
// URL or API key. Not wired into any hot path; run directly, ad hoc.

import { RobinhoodChainClient } from "../src/blockchain/robinhoodChainClient.js";
import { loadChainConfigFromEnv, describeRpcEndpointSafely, PONS_ADDRESSES } from "../src/blockchain/chainConfig.js";
import { PONS_V2_CURVE_ABI } from "../src/market-data/ponsV2Abi.js";

const BIOHACKING_CURVE = "0xd89C13518D569c2162722410e0B8A5816B6B1d87";

function redactUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"')]+/g, "<redacted-url>");
}

async function probeRange(client: RobinhoodChainClient, fromBlock: bigint, toBlock: bigint, label: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const logs = await client.getLogs({ address: BIOHACKING_CURVE as `0x${string}`, event: PONS_V2_CURVE_ABI[0], fromBlock, toBlock });
    console.log(`  ${label} (${toBlock - fromBlock + 1n} blocks): OK  latency=${Date.now() - startedAt}ms  logs=${logs.length}`);
  } catch (error) {
    const msg = redactUrls(error instanceof Error ? error.message : String(error));
    console.log(`  ${label} (${toBlock - fromBlock + 1n} blocks): FAIL  latency=${Date.now() - startedAt}ms`);
    console.log(`      error: ${msg.slice(0, 200).replace(/\n/g, " ")}`);
  }
}

async function sectionB(client: RobinhoodChainClient): Promise<void> {
  console.log("\n=== §B — Alchemy eth_getLogs range-limit probe (BIOHACKING curve address, same topic) ===");
  const tip = await client.getBlockNumber();
  const sizes = [1n, 10n, 11n, 100n, 1_000n, 10_000n];
  let lastFailed = false;
  for (const size of sizes) {
    if (lastFailed) {
      console.log(`  (skipping larger ranges — already rejected at a smaller size; further tests add no new information)`);
      break;
    }
    const toBlock = tip;
    const fromBlock = tip - size + 1n;
    await probeRange(client, fromBlock, toBlock, `${size}-block range`);
  }
}

async function sectionD(client: RobinhoodChainClient): Promise<void> {
  console.log("\n=== §D — measured Robinhood Chain block production rate ===");
  const tip = await client.getBlockNumber();
  const tipTs = new Date(await client.getBlockTimestamp(tip)).getTime();
  console.log(`  tip block ${tip} @ ${new Date(tipTs).toISOString()}`);

  const offsets = [10n, 100n, 1_000n, 10_000n, 100_000n, 1_000_000n];
  const points: { block: bigint; ts: number }[] = [{ block: tip, ts: tipTs }];
  for (const offset of offsets) {
    const block = tip > offset ? tip - offset : 0n;
    const ts = new Date(await client.getBlockTimestamp(block)).getTime();
    points.push({ block, ts });
    const deltaBlocks = Number(tip - block);
    const deltaSeconds = (tipTs - ts) / 1000;
    const blocksPerSecond = deltaSeconds > 0 ? deltaBlocks / deltaSeconds : NaN;
    const secondsPerBlock = deltaBlocks > 0 ? deltaSeconds / deltaBlocks : NaN;
    console.log(
      `  N-${offset.toString().padStart(9)}: block ${block} @ ${new Date(ts).toISOString()}  ` +
        `spans ${deltaSeconds.toFixed(1)}s over ${deltaBlocks} blocks  => ${blocksPerSecond.toFixed(3)} blocks/sec (${secondsPerBlock.toFixed(4)} sec/block)`,
    );
  }
}

async function main(): Promise<void> {
  const configured = loadChainConfigFromEnv();
  console.log(`Using: ${describeRpcEndpointSafely(configured.rpcUrl)}`);
  const client = new RobinhoodChainClient({ config: configured });

  await sectionD(client);
  await sectionB(client);
}

main().catch((error) => {
  console.error("probe failed", redactUrls(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
