// Chain access: provider, chunked getLogs (works around the Paseo gateway's
// range limits + occasional topic-filter drops), and a block-timestamp cache.
import { JsonRpcProvider } from "ethers";
import { RPC_URL, CHUNK_SIZE } from "./config.js";
import { getBlockTs, putBlockTs } from "./db.js";

export const provider = new JsonRpcProvider(RPC_URL);

export async function headBlock() {
  return await provider.getBlockNumber();
}

// Fetch logs for the given addresses across [fromBlock, toBlock], chunked.
// We filter by address only (no topic filter) because the gateway intermittently
// drops topic filters — we decode + discard unknown events ourselves downstream.
export async function getLogsChunked(addressList, fromBlock, toBlock, onChunk) {
  for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, toBlock);
    const logs = await getLogsWithRetry(addressList, start, end);
    await onChunk(logs, start, end);
  }
}

async function getLogsWithRetry(addressList, fromBlock, toBlock, depth = 0) {
  try {
    return await provider.getLogs({ address: addressList, fromBlock, toBlock });
  } catch (e) {
    // Range too large / transient gateway error — split and recurse.
    if (toBlock > fromBlock && depth < 8) {
      const mid = Math.floor((fromBlock + toBlock) / 2);
      const left = await getLogsWithRetry(addressList, fromBlock, mid, depth + 1);
      const right = await getLogsWithRetry(addressList, mid + 1, toBlock, depth + 1);
      return left.concat(right);
    }
    throw e;
  }
}

// Resolve timestamps for a set of block numbers, caching in SQLite so each
// block is fetched at most once across runs.
export async function resolveTimestamps(blockNumbers) {
  const missing = [...new Set(blockNumbers)].filter((n) => getBlockTs(n) == null);
  // Modest concurrency to stay friendly to the public gateway.
  const BATCH = 8;
  for (let i = 0; i < missing.length; i += BATCH) {
    const slice = missing.slice(i, i + BATCH);
    const blocks = await Promise.all(slice.map((n) => provider.getBlock(n)));
    for (const b of blocks) {
      if (b) putBlockTs(b.number, b.timestamp);
    }
  }
}
