// Derived network-effect metrics computed over the whole market — the queries
// the per-wallet webapp dashboards architecturally can't run. planck sums use
// BigInt; charts get a Number DOT value (fine at testnet magnitudes).
import { db } from "./db.js";

const PLANCK = 10_000_000_000n; // 1 DOT = 1e10 planck
const DAY = 86400;

function sumPlanck(rows, ...cols) {
  let t = 0n;
  for (const r of rows) for (const c of cols) t += BigInt(r[c] ?? "0");
  return t;
}
const toDot = (planck) => Number((planck * 1000n) / PLANCK) / 1000; // 3dp

export function summary() {
  const settle = db.prepare("SELECT publisher_payment, user_payment, protocol_fee, event_count FROM settlements").all();
  const impressions = settle.reduce((s, r) => s + r.event_count, 0);
  const pubRev = sumPlanck(settle, "publisher_payment");
  const userEarn = sumPlanck(settle, "user_payment");
  const protocol = sumPlanck(settle, "protocol_fee");
  const settledTotal = pubRev + userEarn + protocol;

  const publishers = db.prepare("SELECT COUNT(*) n FROM publishers").get().n;
  const campaigns = db.prepare("SELECT COUNT(*) n FROM campaigns").get().n;
  const active = db.prepare("SELECT COUNT(*) n FROM campaigns WHERE activated_block IS NOT NULL").get().n;
  const rejections = db.prepare("SELECT COUNT(*) n FROM rejections").get().n;
  const clicks = db.prepare("SELECT COUNT(*) n FROM clicks").get().n;
  const settlements = settle.length;
  const uniqueUsers = db.prepare("SELECT COUNT(DISTINCT user) n FROM settlements").get().n;

  const attempts = settlements + rejections;
  return {
    publishers,
    campaigns,
    activeCampaigns: active,
    settlements,
    rejections,
    clicks,
    impressions,
    uniqueUsers,
    settledDot: toDot(settledTotal),
    publisherRevenueDot: toDot(pubRev),
    userEarningsDot: toDot(userEarn),
    protocolFeesDot: toDot(protocol),
    // Settlement success rate — proxy for fill quality (settled vs rejected claims).
    settlementSuccessRate: attempts ? settlements / attempts : null,
    // eCPM = settled DOT per 1000 impressions.
    ecpmDot: impressions ? toDot((settledTotal * 1000n) / BigInt(impressions)) : null,
    // Liquidity = demand/supply proxy (active campaigns per registered publisher).
    liquidityRatio: publishers ? active / publishers : null,
  };
}

// Daily buckets joined to real block timestamps.
export function timeseries() {
  const q = (sql) => db.prepare(sql).all();
  const day = (ts) => Math.floor(ts / DAY) * DAY;

  const settle = q(`
    SELECT b.ts ts, s.event_count ec, s.user u, s.publisher_payment pp, s.user_payment up, s.protocol_fee pf
    FROM settlements s JOIN blocks b ON b.number = s.block`);
  const camps = q("SELECT c.block, b.ts ts FROM campaigns c JOIN blocks b ON b.number = c.block");
  const pubs = q("SELECT p.block, b.ts ts FROM publishers p JOIN blocks b ON b.number = p.block");
  const clk = q("SELECT b.ts ts FROM clicks c JOIN blocks b ON b.number = c.block");

  const buckets = new Map();
  const bucket = (ts) => {
    const d = day(ts);
    if (!buckets.has(d))
      buckets.set(d, { day: d, impressions: 0, settledPlanck: 0n, users: new Set(), clicks: 0, newPublishers: 0, newCampaigns: 0 });
    return buckets.get(d);
  };
  for (const r of settle) {
    const k = bucket(r.ts);
    k.impressions += r.ec;
    k.settledPlanck += BigInt(r.pp) + BigInt(r.up) + BigInt(r.pf);
    k.users.add(r.u);
  }
  for (const r of camps) bucket(r.ts).newCampaigns++;
  for (const r of pubs) bucket(r.ts).newPublishers++;
  for (const r of clk) bucket(r.ts).clicks++;

  return [...buckets.values()]
    .sort((a, b) => a.day - b.day)
    .map((k) => ({
      date: new Date(k.day * 1000).toISOString().slice(0, 10),
      impressions: k.impressions,
      settledDot: toDot(k.settledPlanck),
      dau: k.users.size,
      clicks: k.clicks,
      newPublishers: k.newPublishers,
      newCampaigns: k.newCampaigns,
    }));
}

// Clearing-rate distribution (ratePlanck), log-ish DOT buckets.
export function cpmHistogram() {
  const rows = db.prepare("SELECT rate_planck FROM settlements").all();
  const hist = new Map();
  for (const r of rows) {
    const dot = toDot(BigInt(r.rate_planck));
    // bucket label by order of magnitude in DOT
    const b = dot === 0 ? "0" : dot < 0.001 ? "<0.001" : dot < 0.01 ? "0.001–0.01" : dot < 0.1 ? "0.01–0.1" : dot < 1 ? "0.1–1" : "≥1";
    hist.set(b, (hist.get(b) || 0) + 1);
  }
  const order = ["0", "<0.001", "0.001–0.01", "0.01–0.1", "0.1–1", "≥1"];
  return order.filter((b) => hist.has(b)).map((b) => ({ bucket: b, count: hist.get(b) }));
}

export function topPublishers(limit = 20) {
  const rows = db.prepare("SELECT publisher, publisher_payment, event_count FROM settlements").all();
  const m = new Map();
  for (const r of rows) {
    const e = m.get(r.publisher) || { publisher: r.publisher, planck: 0n, impressions: 0 };
    e.planck += BigInt(r.publisher_payment);
    e.impressions += r.event_count;
    m.set(r.publisher, e);
  }
  return [...m.values()]
    .map((e) => ({ publisher: e.publisher, revenueDot: toDot(e.planck), impressions: e.impressions }))
    .sort((a, b) => b.revenueDot - a.revenueDot)
    .slice(0, limit);
}

export function topCampaigns(limit = 20) {
  const settle = db.prepare("SELECT campaign_id, publisher_payment, user_payment, protocol_fee, event_count FROM settlements").all();
  const m = new Map();
  for (const r of settle) {
    const e = m.get(r.campaign_id) || { campaign_id: r.campaign_id, planck: 0n, impressions: 0 };
    e.planck += BigInt(r.publisher_payment) + BigInt(r.user_payment) + BigInt(r.protocol_fee);
    e.impressions += r.event_count;
    m.set(r.campaign_id, e);
  }
  const meta = db.prepare("SELECT campaign_id, advertiser, total_budget_planck, activated_block FROM campaigns").all();
  const byId = Object.fromEntries(meta.map((c) => [c.campaign_id, c]));
  return [...m.values()]
    .map((e) => {
      const c = byId[e.campaign_id];
      const budget = c ? BigInt(c.total_budget_planck) : 0n;
      const spentPlanck = e.planck;
      return {
        campaign_id: e.campaign_id,
        advertiser: c?.advertiser ?? null,
        impressions: e.impressions,
        spentDot: toDot(spentPlanck),
        budgetDot: toDot(budget),
        budgetUtilization: budget > 0n ? Number((spentPlanck * 1000n) / budget) / 1000 : null,
        activated: c ? c.activated_block != null : null,
      };
    })
    .sort((a, b) => b.spentDot - a.spentDot)
    .slice(0, limit);
}

// R1.3 — value conservation (BRAINSTORM probe 4.1) + user-payout visibility.
// Two invariants, checkable from events alone:
//   1. credited == settled   (the vault is credited exactly what settlement computed)
//   2. withdrawn <= credited  (solvency — the vault never pays out more than it holds)
// Plus the DATUM emission leg, which is currently dark (token plane not deployed).
export function conservation() {
  const settle = db.prepare("SELECT publisher_payment, user_payment, protocol_fee FROM settlements").all();
  const settledTotal = sumPlanck(settle, "publisher_payment", "user_payment", "protocol_fee");

  const credited = sumPlanck(db.prepare("SELECT total_planck FROM vault_credits").all(), "total_planck");
  const wq = (kind) =>
    sumPlanck(db.prepare("SELECT amount_planck FROM vault_withdrawals WHERE kind = ?").all(kind), "amount_planck");
  const wPub = wq("publisher");
  const wUser = wq("user");
  const wProto = wq("protocol");
  const swept = sumPlanck(db.prepare("SELECT amount_planck FROM fee_sweeps").all(), "amount_planck");
  const withdrawnTotal = wPub + wUser + wProto + swept;

  const emRows = db.prepare("SELECT effective_mint, dot_paid FROM emissions").all();
  const effMint = emRows.reduce((t, r) => t + BigInt(r.effective_mint ?? "0"), 0n);
  const mintFailures = db.prepare("SELECT COUNT(*) n FROM mint_failures").get().n;
  const tokenPlaneActive = effMint > 0n;

  const nCredits = db.prepare("SELECT COUNT(*) n FROM vault_credits").get().n;
  return {
    // ── DOT conservation (fully measurable today) ──
    settledTotalDot: toDot(settledTotal),
    creditedTotalDot: toDot(credited),
    creditedMatchesSettled: settledTotal === credited,
    creditedMinusSettledPlanck: (credited - settledTotal).toString(),
    withdrawals: {
      publisherDot: toDot(wPub),
      userDot: toDot(wUser),
      protocolDot: toDot(wProto),
      feeShareSweepDot: toDot(swept),
      totalDot: toDot(withdrawnTotal),
    },
    solvent: withdrawnTotal <= credited,
    outstandingVaultDot: toDot(credited - withdrawnTotal),
    // ── DATUM emission leg (user-payout loop, gap #4) ──
    emission: {
      tokenPlaneActive,
      effectiveMintRaw: effMint.toString(),
      mintComputedEvents: emRows.length,
      mintFailures,
      note: tokenPlaneActive
        ? null
        : "No MintComputed events indexed yet — the emission + fee-share + bootstrap payout loop hasn't fired (or hasn't been backfilled). On alpha-core the token plane (emissionEngine/mintCoordinator/mintAuthority/feeShare) is deployed; exercise it with datum/alpha-core/scripts/verify-mint-e2e.ts, then backfill from the deploy block.",
    },
    _note:
      nCredits === 0
        ? "No SettlementCredited events indexed yet — backfill from the alpha-core deploy block (set START_BLOCK) or wait for the tail to catch up."
        : null,
  };
}

// R1.5 — settlement-aggregation compression measurement (the number that gates
// the DatumSettlementRoot decision in SETTLEMENT-AGGREGATION-DESIGN.md).
//
// Today each ClaimSettled is its own batch=1 on-chain tx (~49k gas). Under the
// proposed hybrid optimistic checkpoint, an epoch's claims collapse into:
//   (distinct users)      user-payout credit rows
// + (distinct publishers) publisher-payout credit rows
// + (distinct campaigns)  escrow-debit rows
// + 1                     Merkle root commit
// compressionVsClaims = claims_in_epoch / those aggregated rows = how many
// per-claim txs one aggregated settlement replaces. High ⇒ build it.
export function aggregation(epochBlocks = 14400) {
  const rows = db.prepare("SELECT block, campaign_id, user, publisher, event_count FROM settlements").all();
  const nClaims = rows.length;
  const nImpressions = rows.reduce((t, r) => t + r.event_count, 0);
  const distinct = (sel) => new Set(rows.map(sel)).size;

  const byEpoch = new Map();
  for (const r of rows) {
    const e = Math.floor(r.block / epochBlocks);
    if (!byEpoch.has(e))
      byEpoch.set(e, { epoch: e, claims: 0, impressions: 0, users: new Set(), publishers: new Set(), campaigns: new Set() });
    const b = byEpoch.get(e);
    b.claims++;
    b.impressions += r.event_count;
    b.users.add(r.user);
    b.publishers.add(r.publisher);
    b.campaigns.add(r.campaign_id);
  }
  const epochs = [...byEpoch.values()]
    .map((b) => {
      const aggregatedRows = b.users.size + b.publishers.size + b.campaigns.size + 1; // +1 root commit
      return {
        epoch: b.epoch,
        claims: b.claims,
        impressions: b.impressions,
        users: b.users.size,
        publishers: b.publishers.size,
        campaigns: b.campaigns.size,
        aggregatedRows,
        compressionVsClaims: +(b.claims / aggregatedRows).toFixed(2),
        compressionVsImpressions: +(b.impressions / aggregatedRows).toFixed(2),
      };
    })
    .sort((a, b) => a.epoch - b.epoch);

  const totalAggRows = epochs.reduce((t, e) => t + e.aggregatedRows, 0);
  const SUFFICIENT = 200;
  return {
    epochBlocks,
    note:
      nClaims >= SUFFICIENT
        ? null
        : `Low volume (${nClaims} settled claims, want ≥${SUFFICIENT}). The compression ratio is not yet trustworthy — the harness is ready; it needs the R1 load test (plan decision 6) to produce a real number.`,
    headline: {
      meanCompressionVsClaims: totalAggRows ? +(nClaims / totalAggRows).toFixed(2) : null,
      meanCompressionVsImpressions: totalAggRows ? +(nImpressions / totalAggRows).toFixed(2) : null,
      decisionHint:
        "Per SETTLEMENT-AGGREGATION-DESIGN.md: build DatumSettlementRoot if meanCompressionVsClaims is high (rule-of-thumb ≥10); if it sits at ~1–3, revisit netting granularity before committing.",
    },
    overall: {
      claims: nClaims,
      impressions: nImpressions,
      distinctUsers: distinct((r) => r.user),
      distinctPublishers: distinct((r) => r.publisher),
      distinctCampaigns: distinct((r) => r.campaign_id),
      distinctCampaignPublisher: distinct((r) => r.campaign_id + "|" + r.publisher),
    },
    epochs: epochs.slice(-30),
  };
}

export function status() {
  return {
    cursor: db.prepare("SELECT value FROM meta WHERE key='cursor'").get()?.value ?? null,
    rawEvents: db.prepare("SELECT COUNT(*) n FROM raw_events").get().n,
    blocksCached: db.prepare("SELECT COUNT(*) n FROM blocks").get().n,
  };
}
