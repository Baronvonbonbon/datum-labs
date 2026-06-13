// Entry point. `backfill` sweeps from START_BLOCK to head once; `run` backfills
// then tails the head forever. Cursor (last fully-indexed block) lives in meta.
import { START_BLOCK, BACKFILL_DEPTH, POLL_INTERVAL_MS, resolveWatched } from "./config.js";
import { provider, headBlock, getLogsChunked } from "./chain.js";
import { processLogs } from "./indexer.js";
import { meta } from "./db.js";

// Resolved once at startup from the on-chain registry (env-first, seed-file
// fallback) so the indexer tracks governance upgrades automatically.
let ADDR = [];
async function ensureAddrs() {
  if (ADDR.length) return ADDR;
  ADDR = Object.values(await resolveWatched(provider));
  return ADDR;
}

function resolveStart(head) {
  const cursor = meta.getNum("cursor");
  if (cursor != null) return cursor + 1;
  if (START_BLOCK !== "auto") return Number(START_BLOCK);
  return Math.max(0, head - BACKFILL_DEPTH);
}

async function sweep(fromBlock, toBlock) {
  if (fromBlock > toBlock) return;
  let total = 0;
  await getLogsChunked(ADDR, fromBlock, toBlock, async (logs, start, end) => {
    const n = await processLogs(logs);
    total += logs.length;
    meta.set("cursor", end);
    if (logs.length) {
      console.log(`  [${start}-${end}] +${logs.length} logs (indexed ${n})`);
    }
  });
  console.log(`Sweep ${fromBlock}-${toBlock} done — ${total} logs.`);
}

async function backfill() {
  await ensureAddrs();
  const head = await headBlock();
  const from = resolveStart(head);
  console.log(`Backfill: head=${head}, watching ${ADDR.length} contracts, from block ${from}`);
  await sweep(from, head);
  return head;
}

async function run() {
  await backfill();
  console.log(`Tailing every ${POLL_INTERVAL_MS}ms. Ctrl-C to stop.`);
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const head = await headBlock();
      const from = (meta.getNum("cursor") ?? head) + 1;
      if (from <= head) await sweep(from, head);
    } catch (e) {
      console.error("tail error (will retry):", e.message);
    }
  }
}

const mode = process.argv[2] || "run";
const main = mode === "backfill" ? backfill : run;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
