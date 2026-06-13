import "dotenv/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const abs = (p) => resolve(ROOT, p);

export const PUBLISHER_ADDRESS = (process.env.PUBLISHER_ADDRESS || "").trim();
export const RELAY_URL = (process.env.RELAY_URL || "").trim();
export const RELAY_MODE = (process.env.RELAY_MODE || "publisher").trim();
export const TAGS = (process.env.TAGS || "topic:crypto-web3,locale:en").trim();
export const SLOT = (process.env.SLOT || "medium-rectangle").trim();
export const INTERSTITIAL_SECONDS = Number(process.env.INTERSTITIAL_SECONDS || 5);
export const SDK_PATH = abs(process.env.SDK_PATH || "../../datum/sdk/datum-sdk.js");
export const PORT = Number(process.env.PORT || 4320);
export const DB_PATH = abs(process.env.DB_PATH || "data/links.db");

const ZERO = "0x0000000000000000000000000000000000000000";
export function warnConfig() {
  if (!PUBLISHER_ADDRESS || PUBLISHER_ADDRESS === ZERO) {
    console.warn("⚠  PUBLISHER_ADDRESS unset — pages render the house-ad fallback only; no real auction/settlement.");
  }
  if (!RELAY_URL) {
    console.warn("⚠  RELAY_URL unset — clicks won't be reported and settlement can't be submitted.");
  }
}
