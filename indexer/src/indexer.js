// Decode raw logs into typed projections + the raw_events audit table.
import { iface, KNOWN_TOPICS } from "./abis.js";
import { insert, inTxn } from "./db.js";
import { watchedContracts } from "./config.js";
import { resolveTimestamps } from "./chain.js";

// address -> contract-name, built lazily so it reflects the registry-resolved
// watch-set (resolveWatched() runs before any log is processed).
let _label = null;
function labelFor(address) {
  if (!_label) {
    _label = Object.fromEntries(Object.entries(watchedContracts()).map(([k, v]) => [v, k]));
  }
  return _label[address.toLowerCase()] || "unknown";
}

function s(x) {
  return x == null ? null : x.toString();
}

// Decode + persist a batch of logs atomically. Returns the count stored.
export async function processLogs(logs) {
  if (!logs.length) return 0;

  // Resolve block timestamps up front (network) before opening the DB txn.
  await resolveTimestamps(logs.map((l) => Number(l.blockNumber)));

  const store = inTxn((batch) => {
    for (const log of batch) {
      const topic0 = log.topics?.[0];
      if (!topic0 || !KNOWN_TOPICS.has(topic0)) continue;

      let parsed;
      try {
        parsed = iface.parseLog({ topics: log.topics, data: log.data });
      } catch {
        continue;
      }
      if (!parsed) continue;

      const base = {
        tx_hash: log.transactionHash,
        log_index: Number(log.index ?? log.logIndex),
        block: Number(log.blockNumber),
      };
      const a = parsed.args;
      const contract = labelFor(log.address);

      insert.raw({
        ...base,
        contract,
        name: parsed.name,
        json: JSON.stringify(a.toArray().map((v) => (typeof v === "bigint" ? v.toString() : v))),
      });

      switch (parsed.name) {
        case "ClaimSettled":
          insert.settlement({
            ...base,
            campaign_id: Number(a.campaignId),
            user: a.user.toLowerCase(),
            publisher: a.publisher.toLowerCase(),
            event_count: Number(a.eventCount),
            rate_planck: s(a.ratePlanck),
            action_type: Number(a.actionType),
            publisher_payment: s(a.publisherPayment),
            user_payment: s(a.userPayment),
            protocol_fee: s(a.protocolFee),
          });
          break;
        case "ClaimRejected":
          insert.rejection({
            ...base,
            campaign_id: Number(a.campaignId),
            user: a.user.toLowerCase(),
            reason_code: Number(a.reasonCode),
          });
          break;
        case "ClickRecorded":
          insert.click({
            ...base,
            campaign_id: Number(a.campaignId),
            user: a.user.toLowerCase(),
            session_hash: a.sessionHash,
          });
          break;
        case "CampaignCreated":
          insert.campaign({
            campaign_id: Number(a.campaignId),
            block: base.block,
            advertiser: a.advertiser.toLowerCase(),
            publisher: a.publisher.toLowerCase(),
            total_budget_planck: s(a.totalBudgetPlanck),
            take_rate_bps: Number(a.snapshotTakeRateBps),
          });
          break;
        case "CampaignActivated":
          insert.activate(base.block, Number(a.campaignId));
          break;
        case "PublisherRegistered":
          insert.publisher({
            publisher: a.publisher.toLowerCase(),
            block: base.block,
            take_rate_bps: Number(a.takeRateBps),
          });
          break;
        // ── R1.3: PaymentVault value-conservation + payout events ──
        case "SettlementCredited":
          insert.vaultCredit({
            ...base,
            publisher: a.publisher.toLowerCase(),
            user: a.user.toLowerCase(),
            total_planck: s(a.total),
          });
          break;
        case "PublisherWithdrawal":
          insert.vaultWithdrawal({ ...base, kind: "publisher", account: a.publisher.toLowerCase(), amount_planck: s(a.amount) });
          break;
        case "UserWithdrawal":
          insert.vaultWithdrawal({ ...base, kind: "user", account: a.user.toLowerCase(), amount_planck: s(a.amount) });
          break;
        case "ProtocolWithdrawal":
          insert.vaultWithdrawal({ ...base, kind: "protocol", account: a.recipient.toLowerCase(), amount_planck: s(a.amount) });
          break;
        case "SweptToFeeShare":
          insert.feeSweep({ ...base, recipient: a.recipient.toLowerCase(), amount_planck: s(a.amount) });
          break;
        // ── R1.3: DATUM emission orchestration ──
        case "MintComputed":
          insert.emission({ ...base, dot_paid: s(a.dotPaid), raw_mint: s(a.rawMint), effective_mint: s(a.effectiveMint) });
          break;
        case "DatumMintFailed":
          insert.mintFailure({
            ...base,
            user: a.user.toLowerCase(),
            publisher: a.publisher.toLowerCase(),
            advertiser: a.advertiser.toLowerCase(),
            total_mint: s(a.totalMint),
          });
          break;
      }
    }
  });

  store(logs);
  return logs.length;
}
