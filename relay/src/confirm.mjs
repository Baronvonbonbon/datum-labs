// Paseo eth-rpc returns null from getTransactionReceipt for confirmed txs
// (documented quirk; deploy scripts work around it with nonce polling). So
// `tx.wait()` can hang forever. confirmTx polls the receipt within a timeout and,
// if it never arrives, falls back to checking whether the sender's nonce advanced
// (⇒ the tx was included; success unknown — the indexer is the source of truth).
import { provider } from "./provider.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function confirmTx(hash, fromAddress, sentNonce, { timeoutMs = 90000, pollMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await provider.getTransactionReceipt(hash).catch(() => null);
    if (r) return { status: Number(r.status), receipt: r, source: "receipt" };
    // Receipt unreadable — did the nonce advance past this tx? Then it was included.
    if (sentNonce != null) {
      const n = await provider.getTransactionCount(fromAddress, "latest").catch(() => null);
      if (n != null && n > sentNonce) return { status: null, receipt: null, source: "nonce-advanced" };
    }
    await sleep(pollMs);
  }
  return { status: null, receipt: null, source: "timeout" };
}
