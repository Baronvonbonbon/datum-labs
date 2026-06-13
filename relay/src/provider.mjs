import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { RPC_URL, RELAY_PRIVATE_KEY, ADVERTISER_PRIVATE_KEY, ADDR_FILE } from "./config.mjs";
import { DUALSIG_ABI, CLICK_ABI, PUBLISHERS_ABI, PAYMENT_VAULT_ABI, CAMPAIGNS_ABI } from "./abis.mjs";
import { resolveAddresses } from "./registry.mjs";
import { setStatus } from "./telemetry.mjs";
import { log } from "./log.mjs";

export const provider = new JsonRpcProvider(RPC_URL);
export const relayWallet = new Wallet(RELAY_PRIVATE_KEY, provider);
export const advertiserWallet = ADVERTISER_PRIVATE_KEY ? new Wallet(ADVERTISER_PRIVATE_KEY, provider) : null;

// Contract handles are bound in init() once addresses are resolved from the
// chain registry (env-first, seed-file fallback). ESM live bindings let the
// modules that import these see the assigned values — every consumer runs after
// init() awaits in index.mjs::main.
export let dualSig = null;
export let clickRegistry = null;
export let publishers = null;
export let campaigns = null;
export let dualSigAddress = null;
// Gasless-withdrawal target. Null when the deploy predates it; the /withdraw
// endpoint then reports "withdraw-unavailable".
export let paymentVault = null;

export let chainId = null;
export let ready = false;

export async function init() {
  const { addresses: a, routerAddress, source } = await resolveAddresses({ provider, addrFile: ADDR_FILE, log });
  for (const k of ["dualSig", "clickRegistry", "publishers", "campaigns"]) {
    if (!a[k]) throw new Error(`addresses missing key: ${k} (source=${source}, router=${routerAddress ?? "none"})`);
  }

  dualSig = new Contract(a.dualSig, DUALSIG_ABI, relayWallet);
  clickRegistry = new Contract(a.clickRegistry, CLICK_ABI, relayWallet);
  publishers = new Contract(a.publishers, PUBLISHERS_ABI, provider);
  campaigns = new Contract(a.campaigns, CAMPAIGNS_ABI, provider);
  dualSigAddress = a.dualSig;
  paymentVault = a.paymentVault ? new Contract(a.paymentVault, PAYMENT_VAULT_ABI, relayWallet) : null;

  const net = await provider.getNetwork();
  chainId = Number(net.chainId);
  ready = true;
  setStatus({
    chainId,
    signer: relayWallet.address,
    advertiserSigner: advertiserWallet?.address ?? null,
  });
  log.info("provider ready", {
    chainId,
    relay: relayWallet.address,
    advertiser: advertiserWallet?.address ?? "(none)",
    dualSig: dualSigAddress,
    addressSource: source === "router" ? `router:${routerAddress}` : "static-file",
  });
}
