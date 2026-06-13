// SQLite store. Raw log table (idempotent, dedup on tx+logIndex) plus typed
// projections for fast metric queries. planck amounts are stored as TEXT and
// summed with BigInt in JS — they can exceed 2^53.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "./config.js";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS blocks (
  number INTEGER PRIMARY KEY,
  ts     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_events (
  tx_hash   TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block     INTEGER NOT NULL,
  contract  TEXT NOT NULL,
  name      TEXT NOT NULL,
  json      TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS settlements (
  tx_hash           TEXT NOT NULL,
  log_index         INTEGER NOT NULL,
  block             INTEGER NOT NULL,
  campaign_id       INTEGER NOT NULL,
  user              TEXT NOT NULL,
  publisher         TEXT NOT NULL,
  event_count       INTEGER NOT NULL,
  rate_planck       TEXT NOT NULL,
  action_type       INTEGER NOT NULL,
  publisher_payment TEXT NOT NULL,
  user_payment      TEXT NOT NULL,
  protocol_fee      TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_settlements_block ON settlements(block);

CREATE TABLE IF NOT EXISTS rejections (
  tx_hash     TEXT NOT NULL,
  log_index   INTEGER NOT NULL,
  block       INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL,
  user        TEXT NOT NULL,
  reason_code INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_rejections_block ON rejections(block);

CREATE TABLE IF NOT EXISTS clicks (
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  block        INTEGER NOT NULL,
  campaign_id  INTEGER NOT NULL,
  user         TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_clicks_block ON clicks(block);

CREATE TABLE IF NOT EXISTS campaigns (
  campaign_id        INTEGER PRIMARY KEY,
  block              INTEGER NOT NULL,
  advertiser         TEXT NOT NULL,
  publisher          TEXT NOT NULL,
  total_budget_planck TEXT NOT NULL,
  take_rate_bps      INTEGER NOT NULL,
  activated_block    INTEGER
);

CREATE TABLE IF NOT EXISTS publishers (
  publisher     TEXT PRIMARY KEY,
  block         INTEGER NOT NULL,
  take_rate_bps INTEGER NOT NULL
);

-- R1.3: PaymentVault credit per settlement (total = pub+user+protocol of the claim).
CREATE TABLE IF NOT EXISTS vault_credits (
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  block        INTEGER NOT NULL,
  publisher    TEXT NOT NULL,
  user         TEXT NOT NULL,
  total_planck TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_vault_credits_block ON vault_credits(block);

-- R1.3: DOT actually leaving the vault. kind ∈ publisher|user|protocol.
CREATE TABLE IF NOT EXISTS vault_withdrawals (
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  block         INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  account       TEXT NOT NULL,
  amount_planck TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_vault_withdrawals_block ON vault_withdrawals(block);

-- R1.3: protocol-fee sweeps to DatumFeeShare (the WDATUM-staker yield source).
CREATE TABLE IF NOT EXISTS fee_sweeps (
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  block         INTEGER NOT NULL,
  recipient     TEXT NOT NULL,
  amount_planck TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

-- R1.3: DATUM emission per settlement (token-plane payout loop). dot_paid drives
-- the mint; effective_mint is what was actually minted (0 until the plane lands).
CREATE TABLE IF NOT EXISTS emissions (
  tx_hash        TEXT NOT NULL,
  log_index      INTEGER NOT NULL,
  block          INTEGER NOT NULL,
  dot_paid       TEXT NOT NULL,
  raw_mint       TEXT NOT NULL,
  effective_mint TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

-- R1.3: non-critical mint failures (token plane absent/exhausted) — a count > 0
-- here is the signal that the DATUM payout leg isn't actually paying.
CREATE TABLE IF NOT EXISTS mint_failures (
  tx_hash    TEXT NOT NULL,
  log_index  INTEGER NOT NULL,
  block      INTEGER NOT NULL,
  user       TEXT NOT NULL,
  publisher  TEXT NOT NULL,
  advertiser TEXT NOT NULL,
  total_mint TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
`);

// --- prepared statements ---
const _stmts = {
  setMeta: db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
  getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
  putBlock: db.prepare("INSERT OR IGNORE INTO blocks(number, ts) VALUES(?, ?)"),
  getBlockTs: db.prepare("SELECT ts FROM blocks WHERE number = ?"),
  rawEvent: db.prepare(
    "INSERT OR IGNORE INTO raw_events(tx_hash, log_index, block, contract, name, json) VALUES(@tx_hash, @log_index, @block, @contract, @name, @json)",
  ),
  settlement: db.prepare(
    `INSERT OR IGNORE INTO settlements(tx_hash, log_index, block, campaign_id, user, publisher, event_count, rate_planck, action_type, publisher_payment, user_payment, protocol_fee)
     VALUES(@tx_hash, @log_index, @block, @campaign_id, @user, @publisher, @event_count, @rate_planck, @action_type, @publisher_payment, @user_payment, @protocol_fee)`,
  ),
  rejection: db.prepare(
    "INSERT OR IGNORE INTO rejections(tx_hash, log_index, block, campaign_id, user, reason_code) VALUES(@tx_hash, @log_index, @block, @campaign_id, @user, @reason_code)",
  ),
  click: db.prepare(
    "INSERT OR IGNORE INTO clicks(tx_hash, log_index, block, campaign_id, user, session_hash) VALUES(@tx_hash, @log_index, @block, @campaign_id, @user, @session_hash)",
  ),
  campaign: db.prepare(
    "INSERT OR IGNORE INTO campaigns(campaign_id, block, advertiser, publisher, total_budget_planck, take_rate_bps) VALUES(@campaign_id, @block, @advertiser, @publisher, @total_budget_planck, @take_rate_bps)",
  ),
  activate: db.prepare("UPDATE campaigns SET activated_block = ? WHERE campaign_id = ? AND activated_block IS NULL"),
  publisher: db.prepare(
    "INSERT OR IGNORE INTO publishers(publisher, block, take_rate_bps) VALUES(@publisher, @block, @take_rate_bps)",
  ),
  vaultCredit: db.prepare(
    "INSERT OR IGNORE INTO vault_credits(tx_hash, log_index, block, publisher, user, total_planck) VALUES(@tx_hash, @log_index, @block, @publisher, @user, @total_planck)",
  ),
  vaultWithdrawal: db.prepare(
    "INSERT OR IGNORE INTO vault_withdrawals(tx_hash, log_index, block, kind, account, amount_planck) VALUES(@tx_hash, @log_index, @block, @kind, @account, @amount_planck)",
  ),
  feeSweep: db.prepare(
    "INSERT OR IGNORE INTO fee_sweeps(tx_hash, log_index, block, recipient, amount_planck) VALUES(@tx_hash, @log_index, @block, @recipient, @amount_planck)",
  ),
  emission: db.prepare(
    "INSERT OR IGNORE INTO emissions(tx_hash, log_index, block, dot_paid, raw_mint, effective_mint) VALUES(@tx_hash, @log_index, @block, @dot_paid, @raw_mint, @effective_mint)",
  ),
  mintFailure: db.prepare(
    "INSERT OR IGNORE INTO mint_failures(tx_hash, log_index, block, user, publisher, advertiser, total_mint) VALUES(@tx_hash, @log_index, @block, @user, @publisher, @advertiser, @total_mint)",
  ),
};

export const meta = {
  set: (k, v) => _stmts.setMeta.run(k, String(v)),
  get: (k) => _stmts.getMeta.get(k)?.value,
  getNum: (k) => {
    const v = _stmts.getMeta.get(k)?.value;
    return v == null ? null : Number(v);
  },
};

export function putBlockTs(number, ts) {
  _stmts.putBlock.run(number, ts);
}
export function getBlockTs(number) {
  return _stmts.getBlockTs.get(number)?.ts ?? null;
}

export const insert = {
  raw: (r) => _stmts.rawEvent.run(r),
  settlement: (r) => _stmts.settlement.run(r),
  rejection: (r) => _stmts.rejection.run(r),
  click: (r) => _stmts.click.run(r),
  campaign: (r) => _stmts.campaign.run(r),
  activate: (block, id) => _stmts.activate.run(block, id),
  publisher: (r) => _stmts.publisher.run(r),
  vaultCredit: (r) => _stmts.vaultCredit.run(r),
  vaultWithdrawal: (r) => _stmts.vaultWithdrawal.run(r),
  feeSweep: (r) => _stmts.feeSweep.run(r),
  emission: (r) => _stmts.emission.run(r),
  mintFailure: (r) => _stmts.mintFailure.run(r),
};

// Wrap a function so all its inserts commit atomically (big speedup on backfill).
export const inTxn = (fn) => db.transaction(fn);
