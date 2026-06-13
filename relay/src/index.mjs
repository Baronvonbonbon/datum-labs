// DATUM lab relay entry point. Wires the provider, click + claim batchers, and
// the HTTP surface, then runs until interrupted.
import { assertConfig } from "./config.mjs";
import { init } from "./provider.mjs";
import { ClickBatch } from "./clicks.mjs";
import { ClaimQueue } from "./claims.mjs";
import { startHttp } from "./http.mjs";
import { startAdmin } from "./admin.mjs";
import { loadPolicy, acceptClaim, policySummary } from "./policy.mjs";
import { log } from "./log.mjs";

async function main() {
  assertConfig();
  loadPolicy();
  await init();

  // Operator policy gate: campaign + publisher allowlists + rate cap.
  const accept = (cid, publisher, rateWei) => acceptClaim(cid, publisher, rateWei);

  const clickBatch = new ClickBatch(accept);
  const claimQueue = new ClaimQueue(accept);
  clickBatch.start();
  claimQueue.start();
  const server = startHttp({ clickBatch, claimQueue });
  const admin = startAdmin({ claimQueue, log });

  log.info("relay up", { policy: policySummary().source });

  const shutdown = () => {
    log.info("shutting down");
    clickBatch.stop();
    claimQueue.stop();
    server.close(() => {});
    admin.close(() => {});
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.warn("fatal", { err: String(e?.message ?? e) });
  process.exit(1);
});
