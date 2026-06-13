# DATUM Relay Toolkit — Release Scope

Turning the lab relay into a **self-deployable toolset** anyone can run to operate
their own DATUM relay + advertiser co-signer, with monitoring and policy config.

Status as of 2026-05-29: the core is **built and running** (see "Shipped" below).
This doc scopes what's done vs. what a public toolset release still needs.

---

## Who runs this & why

A **relay operator** brokers settlement for publishers who delegate their on-chain
`relaySigner` to the operator's key. The operator pays gas; publishers/users settle
gas-free. An **advertiser** (or their agent) runs the co-signer so the dual-sig
refutation guarantee holds. The toolkit must let either party stand up, scope,
monitor, and secure their service without reading the contracts.

## Architecture (two services + a console)

```
 testers / SDK ──HMAC──► publisher relay ──HTTP──► advertiser co-signer
                          (relaySigner key)         (advertiser key)
                          pipelined submit              │ independent
                          policy gate                   │ refusal
                                │                        ▼
                                └──────► DatumDualSigSettlement ──► chain
                          /dashboard + /api/status (operator console)
```

---

## ✅ Shipped (built + verified this session)

| Capability | Where |
|---|---|
| Pipelined settlement submitter (~65/min, manual nonce, reconcile) | `relay/src/claims.mjs` |
| Independent advertiser co-signer (ownership check + rate cap + refusal) | `advertiser-cosigner/` |
| HMAC auth on `/claim` `/click` `/cosign` (trusted-tester gate) | `relay/src/auth.mjs` |
| **Local-only operator console** (KPIs, throughput, policy, events, co-signer, config editor, approval queue) | `relay/src/admin.mjs` + `relay/public/dashboard.html` on `127.0.0.1:3420` |
| **Public/admin split** — claim API tunnel-exposed; dashboard + all write/config endpoints LOCAL-only | `http.mjs` (public) vs `admin.mjs` (local) |
| **Live config editing** — add/remove publishers + campaigns, max-CPM, raw-config editor; hot (no restart) | `relay/src/policy.mjs` mutators + `POST /api/policy/*`, `/api/config` |
| **Programmatic vs manual signing** — per-relay/per-campaign; manual = hold batches in an approval queue, operator Signs/Rejects | `policy.signingModeFor` + `claims.mjs` pendingApproval + `POST /api/approve` `/api/reject` |
| Operator scripts: register-publisher, create-campaign, preflight, load, scenario | `relay/scripts/` |
| Persistent run/stop + gitignored secrets | `deploy/run-independent.sh`, `stop-independent.sh` |
| Cloudflare tunnel deploy (shared or standalone) | `deploy/tunnel-setup.md` |

Verified end-to-end: public signed round-trip over `pub-relay.example.com`, dashboard
live, policy rejects non-allowed campaigns, co-signer refuses non-owned campaigns.

---

## 🔲 Gaps to a public toolset release

### 1. Packaging & onboarding
- One-command bootstrap (`npx datum-relay init` or a setup script): generate keys,
  write `.env` + `relay.config.json`, print the `setRelaySigner` tx the publisher must send.
- **systemd unit templates** for boot-persistence (today the services are nohup, not
  boot-persistent; only cloudflared is a unit). Ship `datum-relay.service` / `datum-cosigner.service`.
- Versioned releases, a single README per role (publisher-relay operator vs advertiser).

### 2. Config — make it operator-grade
- **Hot reload** of `relay.config.json` (today: restart to apply) — watch + reload, or a
  `POST /admin/reload` behind auth.
- **On-chain verification** of accepted publishers: confirm `publishers.relaySigner(pub) ==
  our key` before co-signing (today the contract enforces it at settle, wasting gas on
  mismatch; pre-checking saves it). Cache per-publisher.
- Co-signer config parity: advertiser allowlist + per-campaign budget/pacing policy file
  (today: ownership check + flat `MAX_CPM_PLANCK`).
- A config **editor in the console** (currently read-only view).

### 3. Monitoring & alerting (beyond the live dashboard)
- **Alerts**: low gas balance, rising error rate, stuck txs, co-signer unreachable, queue
  backlog — webhook/email/Telegram.
- **Persistence**: the dashboard is in-memory (ring buffer + counters); a real operator
  wants history — export metrics (Prometheus `/metrics` format) + retain settlement logs.
- **Reconciliation**: "did claim X settle?" lookup; daily settled-DOT vs gas-spent P&L.
- Per-publisher / per-campaign breakdowns (today: global counters).

### 4. Security hardening (roadmap A3, beyond HMAC)
- ✅ Dashboard + config now **local-only** (separate admin server on `127.0.0.1`, never
  tunnel-exposed) — closed the public-leak. Public surface is just `/claim /click /health
  /metrics`. (If remote admin is ever wanted, gate behind Cloudflare Access — don't HMAC it.)
- **Rate-limiting** on `/claim` (HMAC stops randoms, but a leaked secret = gas drain).
- HMAC is a trusted-tester gate, **not** the public model — public claims from the SDK
  need real impression attestation (roadmap **A2**), since a browser can't hold a secret.
- Key management: hot relaySigner key separate from the publisher's cold key (the toolkit
  should default to `setRelaySigner(hotKey)` rather than signing with the account key).
- Secret rotation tooling.
- ✅ **Dual-sig independence gate (A1, 2026-06-13).** A publicly-exposed relay
  (`HTTP_BIND` ≠ loopback, or `RELAY_PUBLIC=1`) now **refuses to start** in "self-cosign"
  mode — i.e. with `ADVERTISER_PRIVATE_KEY` set and no independent co-signer — because that
  collapses dual-sig refutation (one operator signs both sides). Production must run an
  **independent advertiser co-signer** (`ADVERTISER_COSIGNER_URL`/`ADVERTISER_COSIGNERS`,
  `ADVERTISER_PRIVATE_KEY` unset). Loopback dev may self-cosign with a loud `[SECURITY]`
  warning; an exposed relay may only do so via the explicit `ALLOW_INSECURE_SELF_COSIGN=1`.
  Backstopped on-chain: `DatumDualSigSettlement` reverts `E89` if both signatures recover to
  the same key. (Regulatory rationale + evidence: `../datum-venture/regulatory/18-relay-independence-verification.md`.)

### 5. Economics & multi-tenancy
- **Fee model**: the relay pays gas — let operators take a cut (config'd bps) so it's
  sustainable. Wire to a fee-collection path.
- **Submitter pool** (the next throughput lever): N gas-payer EOAs broadcasting the single
  relaySigner's off-chain sigs in parallel — permissionless submission makes this clean.
- Multi-publisher dashboards + per-tenant policy.

### 6. Robustness
- The Paseo receipt-null + per-tx weight cap (batch=1) are chain-specific — abstract a
  "settlement backend" so the same toolkit works on other chains/params.
- Graceful config/secret validation on boot with clear errors.
- The restart race (EADDRINUSE on quick stop→start) is patched in `stop-independent.sh`;
  systemd units would remove the class of issue.

---

## Suggested release milestones

- **M1 — Operable (≈ here):** two services + console + policy + HMAC + tunnel deploy. ✅
- **M2 — Self-deployable:** init script + systemd units + per-role READMEs + dashboard auth
  + balance/error alerts. *(smallest set that lets a stranger run one safely)*
- **M3 — Operator-grade:** hot config reload + on-chain publisher verify + Prometheus export
  + reconciliation + rate-limiting + fee model.
- **M4 — Scale & open:** submitter pool + A2 attestation (public claims) + multi-tenant +
  chain-abstraction.

**Recommended next:** M2. The thing blocking "anyone can run their own" is not features —
it's a clean install path (init + systemd), dashboard auth, and a low-balance alert. The
mechanism already works; make it safe to hand to a stranger.
