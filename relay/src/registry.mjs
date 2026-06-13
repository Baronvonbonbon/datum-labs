// registry.mjs — canonical contract-address resolution for the DATUM lab.
//
// Trust-root order (env-first, file fallback — see datum-labs README):
//   • Router address:  DATUM_GOVERNANCE_ROUTER   (else the seed file's governanceRouter)
//   • Seed file:       DATUM_ADDRESSES           (else ../../datum/alpha-core/deployed-addresses.json)
//
// With a provider + a router address, every known contract is resolved LIVE from
// DatumGovernanceRouter.currentAddrOf(keccak256(name)), so the lab automatically
// tracks governance upgrades. Each slot falls back to the seed file when the
// registry returns zero (fresh deploy / unregistered helper). In production set
// DATUM_GOVERNANCE_ROUTER + RPC_URL and the lab is self-contained — no sibling
// datum repo needed. For local dev the alpha-core seed file alone is enough.
//
// Mirrors web/src/shared/contracts.ts::resolveAddressesFromRouter — keep the slot
// list and health checks in sync with it.

import { readFileSync } from "node:fs";
import { Contract, ZeroAddress, keccak256, toUtf8Bytes } from "ethers";

const ROUTER_ABI = ["function currentAddrOf(bytes32) view returns (address)"];

// Names registered in DatumGovernanceRouter (mirror of UPGRADABLE_KEYS +
// REGISTRY_ONLY_KEYS in datum/alpha-core/scripts/deploy.ts). Union'd at runtime
// with whatever address keys the seed file carries, so drift here only costs a
// per-slot fall back to the seed, never a hard miss.
export const KNOWN_SLOTS = [
  "pauseRegistry", "campaigns", "settlement", "publishers", "campaignLifecycle",
  "budgetLedger", "paymentVault", "relay", "zkVerifier", "claimValidator",
  "tokenRewardVault", "publisherStake", "challengeBonds", "publisherGovernance",
  "parameterGovernance", "council", "clickRegistry", "powEngine", "publisherReputation",
  "nullifierRegistry", "settlementRateLimiter", "campaignCreative", "reports",
  "campaignAllowlist", "tagSystem", "mintCoordinator", "dualSig", "blocklistCurator",
  "activationBonds", "stakeRoot", "stakeRootV2", "identityVerifier", "emissionEngine",
  "peopleChainIdentity", "peopleChainXcmBridge", "peopleChainBondedReporter",
  "governanceV2", "timelock",
  // registry-only (not on the upgrade ladder, still resolvable via the router)
  "attestationVerifier", "advertiserStake", "advertiserGovernance", "interestCommitments",
  "tagCurator", "relayStake", "relayGovernance", "wrapper", "mintAuthority", "vesting", "feeShare",
];

// Slots any live DATUM deploy MUST have registered. A zero here means the
// configured router is wrong/old/empty — surfaced as health.registryEmpty.
const CORE_SLOTS = ["campaigns", "settlement", "publishers"];

// Seed keys that are not contract addresses — passed through untouched.
const NON_SLOT_KEYS = new Set(["network", "deployedAt", "tokenAssetId"]);

export function loadSeed(addrFile) {
  try {
    return JSON.parse(readFileSync(addrFile, "utf8"));
  } catch {
    return null;
  }
}

export function routerAddressFrom(seed) {
  const env = (process.env.DATUM_GOVERNANCE_ROUTER || "").trim();
  return env || (seed && seed.governanceRouter) || null;
}

// Resolve the live address map.
// Returns { addresses, routerAddress, source: "router" | "file", health }.
export async function resolveAddresses({ provider, addrFile, log = console } = {}) {
  const seed = loadSeed(addrFile);
  const routerAddress = routerAddressFrom(seed);
  const out = { ...(seed || {}) };

  // No way to reach the chain registry → fall back to the static seed file.
  if (!routerAddress || !provider) {
    if (!seed) {
      throw new Error(
        "No contract addresses available. Set DATUM_GOVERNANCE_ROUTER (+ RPC_URL) for " +
        `on-chain resolution, or DATUM_ADDRESSES to a deployed-addresses.json. Tried seed file: ${addrFile}`,
      );
    }
    log.warn?.(`[registry] resolving from static file only (no ${routerAddress ? "provider" : "router"}): ${addrFile}`);
    return {
      addresses: out,
      routerAddress: routerAddress || null,
      source: "file",
      health: { source: "file", registryEmpty: false, deadCore: false, upgraded: [] },
    };
  }

  const router = new Contract(routerAddress, ROUTER_ABI, provider);
  const names = [...new Set([...(seed ? Object.keys(seed) : []), ...KNOWN_SLOTS])];
  const upgraded = [];
  const zeroCore = [];

  for (const name of names) {
    if (NON_SLOT_KEYS.has(name) || name === "governanceRouter") continue;
    let live;
    try {
      live = await router.currentAddrOf(keccak256(toUtf8Bytes(name)));
    } catch {
      continue; // network hiccup / unknown selector — keep seed value
    }
    if (live && live !== ZeroAddress) {
      const prev = seed?.[name];
      if (prev && prev.toLowerCase() !== live.toLowerCase()) upgraded.push({ name, seed: prev, live });
      out[name] = live;
    } else if (CORE_SLOTS.includes(name)) {
      zeroCore.push(name);
    }
  }
  out.governanceRouter = routerAddress; // trust root — never resolved via itself

  const registryEmpty = zeroCore.length > 0;
  let deadCore = false;
  if (!registryEmpty && out.campaigns) {
    try {
      const code = await provider.getCode(out.campaigns);
      deadCore = !code || code === "0x";
    } catch {
      /* provider hiccup — don't flag */
    }
  }
  const health = { source: "router", registryEmpty, deadCore, upgraded };

  if (registryEmpty) {
    log.warn?.(`[registry] router ${routerAddress} returned no address for core slot(s) [${zeroCore.join(", ")}] — wrong/old router?`);
  } else if (deadCore) {
    log.warn?.(`[registry] resolved campaigns ${out.campaigns} has no bytecode — deploy may be wiped.`);
  } else if (upgraded.length) {
    log.info?.(`[registry] ${upgraded.length} slot(s) newer than seed: ${upgraded.map((u) => u.name).join(", ")}`);
  } else {
    log.info?.(`[registry] resolved ${names.length} slots from router ${routerAddress}.`);
  }

  return { addresses: out, routerAddress, source: "router", health };
}
