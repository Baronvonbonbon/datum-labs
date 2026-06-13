// ClickRegistry batcher. DatumClickRegistry.recordClick is one-shot + gated to
// msg.sender == relay, so a "batch" is a paced sequence of TXs from the relay.
//
// NOTE (carried over from the canonical skeleton): the SDK's /click body has no
// user address, so the relay uses `publisher` as a stand-in and hashes
// (publisher,slotId,href,ts) into the impression nonce. Production wiring should
// instead join against the impression record captured by the claim queue.
import { keccak256, toUtf8Bytes, isAddress, ZeroAddress } from "ethers";
import { clickRegistry, relayWallet, ready } from "./provider.mjs";
import { confirmTx } from "./confirm.mjs";
import { CLICK_BATCH_SIZE, CLICK_BATCH_MAX_AGE_MS } from "./config.mjs";
import { bump, record } from "./telemetry.mjs";
import { log } from "./log.mjs";

export class ClickBatch {
  constructor(accept) {
    this.accept = accept; // (campaignId: bigint) => boolean
    this.pending = [];
    this._timer = null;
    this._draining = false;
  }

  start() {
    this._timer = setInterval(() => this._maybeFlush().catch(() => {}), 1000);
    this._timer.unref();
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
  }
  size() {
    return this.pending.length;
  }

  enqueue(body) {
    bump("clicksReceived");
    if (!body || typeof body !== "object") return bumpErr("malformed");
    let cid;
    try {
      cid = BigInt(body.campaignId);
    } catch {
      return bumpErr("campaignId");
    }
    const { publisher, slotId, href } = body;
    const verdict = this.accept(cid, publisher);
    if (!verdict.ok) return bumpErr(verdict.reason);

    const nonce = keccak256(toUtf8Bytes(`${publisher ?? ""}:${slotId ?? ""}:${href ?? ""}:${Date.now()}`));
    const user = typeof publisher === "string" && isAddress(publisher) ? publisher : ZeroAddress;
    this.pending.push({ user, campaignId: cid, nonce, receivedAt: Date.now() });
    record("click-queued", { campaignId: cid.toString() });
    if (this.pending.length >= CLICK_BATCH_SIZE) this._maybeFlush().catch(() => {});
    return { ok: true, queued: true };
  }

  async _maybeFlush() {
    if (this._draining || !this.pending.length || !ready) return;
    const tooOld = Date.now() - this.pending[0].receivedAt >= CLICK_BATCH_MAX_AGE_MS;
    if (this.pending.length < CLICK_BATCH_SIZE && !tooOld) return;
    this._draining = true;
    try {
      const batch = this.pending.splice(0, CLICK_BATCH_SIZE);
      log.info("click batch flushing", { n: batch.length });
      for (const c of batch) {
        try {
          const tx = await clickRegistry.recordClick(c.user, c.campaignId, c.nonce);
          bump("clicksSubmitted");
          record("click-tx", { hash: tx.hash, campaignId: c.campaignId.toString() });
          const cf = await confirmTx(tx.hash, relayWallet.address, tx.nonce);
          if (cf.status === 0) throw new Error("reverted on-chain");
        } catch (e) {
          const msg = String(e?.message ?? e);
          bump("clickErrors");
          log.warn("recordClick failed", { err: msg.slice(0, 200) });
          if (!msg.includes("E90")) this.pending.push(c); // E90 = duplicate session, terminal
        }
      }
    } finally {
      this._draining = false;
    }
  }
}

function bumpErr(reason) {
  bump("clickErrors");
  return { ok: false, reason };
}
