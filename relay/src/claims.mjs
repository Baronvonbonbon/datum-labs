// Dual-sig claim queue + PIPELINED settlement submitter (Option 1).
//
// The extension POSTs a SignedClaimBatch envelope to /claim:
//   { user, campaignId, deadlineBlock, claims:[Claim...], userSig,
//     expectedRelaySigner?, expectedAdvertiserRelaySigner?,
//     publisherSig?, advertiserSig? }
// The relay co-signs the missing publisher/advertiser sigs (it holds the
// publisher's relay-signer key) and submits DatumDualSigSettlement.settleSignedClaims.
//
// Throughput design: rather than send→confirm→send (one tx per ~block, the old
// drain-blocking path), the pump fires up to MAX_INFLIGHT txs back-to-back with
// MANUALLY MANAGED nonces and never blocks the queue on confirmation. A separate
// reconciler resolves in-flight txs (receipt OR nonce-advance, per the Paseo
// receipt-null bug) and resubmits stuck ones. estimateGas gates each send so a
// reverting claim never consumes a nonce (no gaps from bad claims).
import { isAddress, ZeroAddress } from "ethers";
import { dualSig, dualSigAddress, relayWallet, advertiserWallet, chainId, ready, provider, campaigns } from "./provider.mjs";
import { computeClaimsHash, signBatch, normalizeClaim } from "./cosign.mjs";
import { CLAIM_BATCH_SIZE, MAX_INFLIGHT, SETTLE_STUCK_MS, ADVERTISER_COSIGNER_URL, ADVERTISER_COSIGNERS, ADVERTISER_COSIGNER_SECRET } from "./config.mjs";
import { signHeaders } from "./auth.mjs";
import { signingModeFor } from "./policy.mjs";
import { bump, record, setStatus } from "./telemetry.mjs";
import { log } from "./log.mjs";

const MAX_QUEUE = 5000;
const MAX_SUBMIT_RETRIES = 3;

export class ClaimQueue {
  constructor(accept) {
    this.accept = accept; // (campaignId, publisher, rateWei) => { ok, reason }
    this.pending = []; // co-signed batches awaiting submission
    this.pendingApproval = new Map(); // id -> { batch, meta } awaiting operator approval (manual mode)
    this._nextId = 1;
    this._inflight = new Map(); // nonce -> { hash, batches, sentAt, attempts }
    this._nextNonce = null;
    this._pumping = false;
    this._reconciling = false;
    this._timer = null;
  }

  start() {
    this._timer = setInterval(() => {
      this._pump().catch((e) => log.warn("pump error", { err: String(e?.message ?? e) }));
      this._reconcile().catch(() => {});
    }, 1000);
    this._timer.unref();
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
  }
  size() {
    return this.pending.length;
  }
  inflight() {
    return this._inflight.size;
  }

  // Validate + co-sign + enqueue. Async because co-signing is async.
  async enqueue(env) {
    bump("claimsReceived");
    if (this.pending.length >= MAX_QUEUE) return err("queue-full");
    if (!env || typeof env !== "object") return err("malformed");
    if (!isAddress(env.user)) return err("user");
    if (!Array.isArray(env.claims) || env.claims.length === 0) return err("no-claims");
    if (!env.userSig) return err("missing:userSig");

    let campaignId;
    try {
      campaignId = BigInt(env.campaignId);
    } catch {
      return err("campaignId");
    }
    const verdict = this.accept(campaignId, env.claims[0]?.publisher, env.claims[0]?.rateWei);
    if (!verdict.ok) return err(verdict.reason);

    const deadlineBlock = BigInt(env.deadlineBlock ?? 0);
    if (deadlineBlock === 0n) return err("missing:deadlineBlock");

    let claims;
    try {
      claims = env.claims.map(normalizeClaim);
    } catch (e) {
      return err("bad-claim:" + (e?.message ?? ""));
    }

    // Defaults: relay co-signs as the publisher's relay signer, so the
    // expectedRelaySigner is the relay address unless the envelope pins one.
    const expectedRelaySigner = env.expectedRelaySigner ?? relayWallet.address;
    const expectedAdvertiserRelaySigner =
      env.expectedAdvertiserRelaySigner ?? (advertiserWallet ? advertiserWallet.address : ZeroAddress);

    const batch = {
      user: env.user,
      campaignId,
      claims,
      deadlineBlock,
      expectedRelaySigner,
      expectedAdvertiserRelaySigner,
      userSig: env.userSig,
      publisherSig: env.publisherSig ?? null,
      advertiserSig: env.advertiserSig ?? null,
    };

    // Programmatic vs manual: in manual mode, hold the batch UN-co-signed for
    // operator review (so they can reject without the relay ever signing).
    if (signingModeFor(campaignId) === "manual") {
      const id = this._nextId++;
      this.pendingApproval.set(id, {
        batch,
        meta: { id, campaignId: campaignId.toString(), publisher: claims[0]?.publisher, user: env.user, claims: claims.length, rateWei: claims[0]?.rateWei?.toString?.(), receivedAt: Date.now() },
      });
      record("claim-held", { id, campaignId: campaignId.toString() });
      this._gauge();
      return { ok: true, queued: true, pendingApproval: true, id, claims: claims.length };
    }

    const c = await this._cosign(batch);
    if (!c.ok) return err(c.reason);
    this.pending.push(batch);
    record("claim-queued", { campaignId: campaignId.toString(), claims: claims.length });
    this._pump().catch(() => {});
    return { ok: true, queued: true, claims: claims.length };
  }

  // Fill publisherSig (relay key) + advertiserSig (local key / co-signer / posted).
  async _cosign(batch) {
    const claimsHash = computeClaimsHash(batch.claims);
    if (!batch.publisherSig) {
      batch.publisherSig = await signBatch(relayWallet, chainId, dualSigAddress, batch, claimsHash);
    }
    if (!batch.advertiserSig) {
      if (advertiserWallet) {
        batch.advertiserSig = await signBatch(advertiserWallet, chainId, dualSigAddress, batch, claimsHash);
      } else if (ADVERTISER_COSIGNER_URL || Object.keys(ADVERTISER_COSIGNERS).length) {
        const sig = await fetchAdvertiserSig(batch);
        if (!sig) return { ok: false, reason: "advertiser-cosigner-refused" };
        batch.advertiserSig = sig;
      } else {
        return { ok: false, reason: "missing:advertiserSig (set ADVERTISER_PRIVATE_KEY, ADVERTISER_COSIGNER_URL/ADVERTISER_COSIGNERS, or post it)" };
      }
    }
    return { ok: true };
  }

  // ── manual-approval controls (admin) ──
  listPending() {
    return [...this.pendingApproval.values()].map((e) => e.meta);
  }
  async approve(id) {
    const e = this.pendingApproval.get(Number(id));
    if (!e) return { ok: false, reason: "not-found" };
    const c = await this._cosign(e.batch);
    if (!c.ok) { this.pendingApproval.delete(Number(id)); return { ok: false, reason: c.reason }; }
    this.pendingApproval.delete(Number(id));
    this.pending.push(e.batch);
    record("claim-approved", { id });
    this._pump().catch(() => {});
    this._gauge();
    return { ok: true, approved: id };
  }
  reject(id) {
    const ok = this.pendingApproval.delete(Number(id));
    if (ok) { record("claim-rejected", { id }); this._gauge(); }
    return { ok, rejected: ok ? id : undefined };
  }
  _gauge() {
    setStatus({ inflight: this._inflight.size, queued: this.pending.length, pendingApproval: this.pendingApproval.size });
  }

  // Re-baseline the local nonce from chain when nothing is in flight (heals any
  // gap left by a dropped tx); trust the local counter while txs are pipelining.
  async _syncNonce() {
    if (this._nextNonce == null || this._inflight.size === 0) {
      const onchain = await provider.getTransactionCount(relayWallet.address, "pending");
      this._nextNonce = Math.max(this._nextNonce ?? 0, onchain);
    }
  }

  // Pump: fire as many settlement txs as the in-flight budget allows, without
  // blocking on confirmation. estimateGas gates each (revert ⇒ no nonce burned).
  async _pump() {
    if (this._pumping || !ready || !this.pending.length) return;
    this._pumping = true;
    try {
      await this._syncNonce();
      while (this.pending.length && this._inflight.size < MAX_INFLIGHT) {
        const group = this.pending.slice(0, CLAIM_BATCH_SIZE);

        let gas;
        try {
          gas = await dualSig.settleSignedClaims.estimateGas(group);
        } catch (e) {
          // Revert at estimate — no tx sent, no nonce burned. ethers doesn't
          // auto-decode estimateGas custom errors, so decode the raw selector via
          // the dualSig interface and prepend the name so _handleReject can
          // classify it (E82 etc.) instead of silently retrying an opaque revert.
          this.pending.splice(0, group.length);
          const name = decodeSettlementError(e);
          const msg = name ? `${name}() ${String(e?.shortMessage ?? e?.message ?? "").slice(0, 100)}` : String(e?.message ?? e);
          this._handleReject(group, msg);
          continue;
        }

        this.pending.splice(0, group.length); // committed to sending
        const nonce = this._nextNonce++;
        try {
          const tx = await dualSig.settleSignedClaims(group, { nonce, gasLimit: (gas * 12n) / 10n });
          this._inflight.set(nonce, { hash: tx.hash, batches: group, sentAt: Date.now(), attempts: 0 });
          bump("claimBatchesSubmitted");
          bump("claimsSubmitted", group.length);
          record("settle-tx", { hash: tx.hash, nonce });
        } catch (e) {
          // Send failed after passing estimate (rpc hiccup / nonce race). Reclaim
          // the nonce (safe: pump is single-flight and in nonce order) and requeue.
          this._nextNonce--;
          this.pending.unshift(...group);
          bump("claimErrors");
          log.warn("send failed; backing off", { err: String(e?.message ?? e).slice(0, 140) });
          break;
        }
      }
    } finally {
      this._pumping = false;
      this._gauge();
    }
  }

  _handleReject(group, msg) {
    bump("claimErrors");
    const reason = String(msg).slice(0, 160);
    const campaignId = group[0]?.campaignId?.toString?.();
    // Deterministic settlement/validator reverts won't change on retry — drop now.
    // Now that DUALSIG_ABI carries the error fragments, these decode to names
    // (E82 = publisher-sig, E83/E85 = advertiser-sig, etc.) instead of an opaque
    // selector, so they match here rather than silently burning 3 retries.
    if (/E(00|11|18|27|28|32|34|8[0-5])\b/.test(msg)) {
      log.warn("claim rejected (terminal)", { reason, campaignId });
      return;
    }
    for (const b of group) {
      b.attempts = (b.attempts || 0) + 1;
      if (b.attempts < MAX_SUBMIT_RETRIES) this.pending.push(b);
      else log.warn("dropping claim after max retries", { reason, campaignId: b.campaignId?.toString?.() });
    }
  }

  // Reconcile in-flight txs: receipt (status) OR nonce-advance (Paseo receipt-null
  // ⇒ mined). Resubmit txs stuck past SETTLE_STUCK_MS, capped.
  async _reconcile() {
    if (this._reconciling || !this._inflight.size) return;
    this._reconciling = true;
    try {
      const latest = await provider.getTransactionCount(relayWallet.address, "latest").catch(() => null);
      for (const [nonce, info] of [...this._inflight]) {
        const r = await provider.getTransactionReceipt(info.hash).catch(() => null);
        if (r) {
          if (Number(r.status) === 0) {
            bump("claimErrors");
            log.warn("settle reverted on-chain", { hash: info.hash, nonce });
          } else {
            bump("claimsConfirmed", info.batches.length);
          }
          this._inflight.delete(nonce);
          continue;
        }
        if (latest != null && latest > nonce) {
          bump("claimsConfirmed", info.batches.length); // mined; receipt unreadable (Paseo)
          this._inflight.delete(nonce);
          continue;
        }
        if (Date.now() - info.sentAt > SETTLE_STUCK_MS) {
          if (++info.attempts > MAX_SUBMIT_RETRIES) {
            this._inflight.delete(nonce);
            bump("claimErrors");
            log.warn("dropping stuck tx", { nonce });
            continue;
          }
          try {
            const tx = await dualSig.settleSignedClaims(info.batches, { nonce });
            info.hash = tx.hash;
            info.sentAt = Date.now();
            log.info("resubmitted stuck tx", { nonce, hash: tx.hash });
          } catch (e) {
            log.warn("resubmit failed", { nonce, err: String(e?.message ?? e).slice(0, 100) });
          }
        }
      }
    } finally {
      this._reconciling = false;
      this._gauge();
    }
  }
}

// Resolve a campaign's advertiser → co-signer base URL. Interim routing: an
// on-chain getCampaignAdvertiser lookup (cached) keyed into ADVERTISER_COSIGNERS,
// falling back to the single ADVERTISER_COSIGNER_URL. This mirrors the production
// path (campaign → advertiser → endpoint); the on-chain profileHash registry will
// later replace the static map with discovered endpoints.
// Decode a settleSignedClaims custom-error revert (E80-E85 etc.) from an
// estimateGas/call exception. ethers v6 leaves estimateGas reverts as an opaque
// selector in e.data / the message; resolve it via the dualSig interface.
function decodeSettlementError(e) {
  try {
    const data = e?.data || e?.info?.error?.data
      || (String(e?.message ?? "").match(/0x[0-9a-fA-F]{8,}/) || [])[0];
    if (!data) return null;
    return dualSig.interface.parseError(data)?.name ?? null;
  } catch { return null; }
}

const _advCache = new Map(); // campaignId -> advertiser (lowercased)
async function cosignerFor(campaignId) {
  const cid = campaignId.toString();
  let adv = _advCache.get(cid);
  if (adv === undefined) {
    try { adv = (await campaigns.getCampaignAdvertiser(cid)).toLowerCase(); }
    catch { adv = null; }
    _advCache.set(cid, adv);
  }
  const entry = adv && ADVERTISER_COSIGNERS[adv];
  if (entry) return { url: entry.url, secret: entry.secret || ADVERTISER_COSIGNER_SECRET };
  if (ADVERTISER_COSIGNER_URL) return { url: ADVERTISER_COSIGNER_URL, secret: ADVERTISER_COSIGNER_SECRET };
  return null;
}

// Ask the independent advertiser co-signer for advertiserSig. It recomputes the
// digest itself, so we only send the claim hashes + rate (for its policy) + the
// envelope fields that bind the signature. Returns the sig or null (refused/down).
async function fetchAdvertiserSig(batch) {
  const target = await cosignerFor(batch.campaignId);
  if (!target) { log.warn("no advertiser co-signer for campaign", { campaignId: batch.campaignId.toString() }); return null; }
  const { url, secret } = target;
  const payload = {
    user: batch.user,
    campaignId: batch.campaignId.toString(),
    deadlineBlock: batch.deadlineBlock.toString(),
    expectedRelaySigner: batch.expectedRelaySigner,
    expectedAdvertiserRelaySigner: batch.expectedAdvertiserRelaySigner,
    claims: batch.claims.map((c) => ({ claimHash: c.claimHash, rateWei: c.rateWei.toString() })),
  };
  const bodyStr = JSON.stringify(payload);
  const headers = { "content-type": "application/json", ...(secret ? signHeaders(secret, bodyStr) : {}) };
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/cosign", {
      method: "POST",
      headers,
      body: bodyStr,
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok && j.advertiserSig) return j.advertiserSig;
    log.warn("advertiser co-signer declined", { status: res.status, reason: j.reason });
    return null;
  } catch (e) {
    log.warn("advertiser co-signer unreachable", { err: String(e?.message ?? e).slice(0, 120) });
    return null;
  }
}

function err(reason) {
  bump("claimErrors");
  return { ok: false, reason };
}
