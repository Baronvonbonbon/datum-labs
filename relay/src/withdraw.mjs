// /withdraw — gasless user-withdrawal submitter ("off-chain worker").
//
// A user signs a DatumPaymentVault WithdrawAuth off-chain (no gas). This relay
// submits DatumPaymentVault.withdrawUserBySig on-chain, pays the gas, and is
// reimbursed up to the user-signed maxFee out of the withdrawn balance. The user
// never needs gas; the relay can't take more than maxFee, redirect the net, or
// replay (the contract enforces all three).
//
// STAGED: requires a DatumPaymentVault deployed WITH withdrawUserBySig. The
// current live vault predates it, so submissions will fail preflight until the
// vault is upgraded. The endpoint degrades gracefully (returns a clear reason).
import { isAddress, ZeroAddress } from "ethers";
import { paymentVault } from "./provider.mjs";
import { bump, record } from "./telemetry.mjs";
import { log } from "./log.mjs";

// The relay's withdrawal fee, charged as a percentage of the withdrawn balance
// (bps — scale-invariant, so it works regardless of the vault's planck/wei
// denomination). The user authorises it as `maxFee` in the WithdrawAuth they
// sign; the contract caps the actual take at the balance, so the relay can never
// overcharge. Default 1% (100 bps), clamped to ≤10% so a misconfig can't drain a
// withdrawal. The user pays this out of their earnings; the relay pays the gas.
const FEE_BPS = (() => {
  let v;
  try { v = BigInt(process.env.RELAY_WITHDRAW_FEE_BPS ?? "100"); } catch { v = 100n; }
  if (v < 0n) v = 0n;
  if (v > 1000n) v = 1000n;
  return v;
})();

// POST /withdraw  { user, recipient?, maxFee, deadline, sig }
export async function submitWithdraw(env) {
  bump("withdrawReceived");
  if (!paymentVault) return { ok: false, reason: "withdraw-unavailable (paymentVault address not configured)" };
  if (!env || typeof env !== "object") return { ok: false, reason: "malformed" };
  if (!isAddress(env.user)) return { ok: false, reason: "user" };
  if (!env.sig) return { ok: false, reason: "missing:sig" };

  const recipient = env.recipient && isAddress(env.recipient) ? env.recipient : ZeroAddress;
  let maxFee, deadline;
  try {
    maxFee = BigInt(env.maxFee ?? 0);
    deadline = BigInt(env.deadline ?? 0);
  } catch {
    return { ok: false, reason: "maxFee/deadline must be integers" };
  }

  // Preflight via estimateGas: surfaces E81 (expired) / E82 (bad sig) / E03
  // (no balance) — and "function not found" while staged — before burning a tx.
  let gas;
  try {
    gas = await paymentVault.withdrawUserBySig.estimateGas(env.user, recipient, maxFee, deadline, env.sig);
  } catch (e) {
    bump("withdrawRejected");
    const m = String(e?.message ?? e);
    const reason = /E81/.test(m) ? "expired" : /E82/.test(m) ? "bad-sig" : /E03/.test(m) ? "no-balance"
      : /not a function|no matching fragment|execution reverted/.test(m) ? "vault-not-upgraded (withdrawUserBySig unavailable)"
      : "preflight: " + m.slice(0, 100);
    return { ok: false, reason };
  }

  try {
    const tx = await paymentVault.withdrawUserBySig(env.user, recipient, maxFee, deadline, env.sig, {
      gasLimit: (gas * 12n) / 10n, // ~20% buffer; estimate is well under the Paseo gas cap
    });
    bump("withdrawSubmitted");
    record("withdraw-tx", { hash: tx.hash, user: env.user, recipient, maxFee: maxFee.toString() });
    log.info("withdraw submitted", { hash: tx.hash, user: env.user });
    return { ok: true, hash: tx.hash, user: env.user, recipient, maxFee: maxFee.toString() };
  } catch (e) {
    bump("withdrawErrors");
    return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
  }
}

// GET /withdraw-info?user=0x..  — the on-chain bits a client needs to build the
// EIP-712 WithdrawAuth: current nonce, withdrawable balance, and the vault domain.
export async function withdrawInfo(user) {
  if (!paymentVault) return { ok: false, reason: "withdraw-unavailable" };
  if (!isAddress(user)) return { ok: false, reason: "user" };
  try {
    const [nonce, balance] = await Promise.all([
      paymentVault.withdrawNonce(user),
      paymentVault.userBalance(user),
    ]);
    // The fee the relay wants for this withdrawal: feeBps% of the balance. The
    // client signs this as `maxFee`; net to the user = balance − recommendedMaxFee.
    const recommendedMaxFee = (balance * FEE_BPS) / 10000n;
    return {
      ok: true,
      user,
      nonce: nonce.toString(),
      userBalanceWei: balance.toString(),
      feeBps: Number(FEE_BPS),
      recommendedMaxFeeWei: recommendedMaxFee.toString(),
      netWei: (balance - recommendedMaxFee).toString(),
      vault: await paymentVault.getAddress(),
      typehash: "WithdrawAuth(address user,address recipient,uint256 maxFee,uint256 nonce,uint256 deadline)",
    };
  } catch (e) {
    return { ok: false, reason: "vault-not-upgraded? " + String(e?.message ?? e).slice(0, 80) };
  }
}
