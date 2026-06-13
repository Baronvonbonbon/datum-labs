// Link store. Tiny by design — a shortener's state is just code → URL + a hit
// counter (hits ≈ interstitial impressions served).
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./config.js";

mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS links (
  code       TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0
);
`);

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function genCode(n = 6) {
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

const _insert = db.prepare("INSERT INTO links(code, url, created_ts, hits) VALUES(?, ?, ?, 0)");
const _get = db.prepare("SELECT code, url, created_ts, hits FROM links WHERE code = ?");
const _hit = db.prepare("UPDATE links SET hits = hits + 1 WHERE code = ?");
const _list = db.prepare("SELECT code, url, created_ts, hits FROM links ORDER BY created_ts DESC LIMIT 200");

export function createLink(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genCode();
    try {
      _insert.run(code, url, Math.floor(Date.now() / 1000));
      return code;
    } catch {
      /* code collision — retry */
    }
  }
  throw new Error("could not allocate a unique code");
}

export const getLink = (code) => _get.get(code);
export const recordHit = (code) => _hit.run(code);
export const listLinks = () => _list.all();
