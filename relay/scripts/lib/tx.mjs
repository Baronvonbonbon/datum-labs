// Paseo-safe tx confirmation for standalone scripts (mirrors src/confirm.mjs):
// poll the receipt, fall back to nonce-advance when the gateway returns null.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function confirm(provider, tx, fromAddr, { timeoutMs = 120000, pollMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await provider.getTransactionReceipt(tx.hash).catch(() => null);
    if (r) return { status: Number(r.status), receipt: r, source: "receipt" };
    const n = await provider.getTransactionCount(fromAddr, "latest").catch(() => null);
    if (n != null && n > tx.nonce) return { status: null, receipt: null, source: "nonce-advanced" };
    await sleep(pollMs);
  }
  return { status: null, receipt: null, source: "timeout" };
}

// Send a contract method, confirm it, and throw on a readable revert.
export async function send(label, wallet, contractMethodPromise) {
  const tx = await contractMethodPromise;
  process.stdout.write(`  ${label} → ${tx.hash} `);
  const c = await confirm(wallet.provider, tx, wallet.address);
  if (c.status === 0) throw new Error(`${label} reverted (${tx.hash})`);
  console.log(c.source === "receipt" ? "✓" : `(submitted; ${c.source})`);
  return tx;
}
