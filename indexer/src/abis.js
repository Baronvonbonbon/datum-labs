// Human-readable event fragments. Signatures verified against datum/alpha-core
// (contracts/ + interfaces/). Filtering is by contract ADDRESS only (the gateway
// drops topic filters), so adding a fragment here + a decode case in indexer.js
// + the contract's address in config.js is all it takes to index a new event.
import { Interface } from "ethers";

export const EVENT_FRAGMENTS = [
  // ── DatumSettlement — the workhorse: clearing rate + the full payment split.
  "event ClaimSettled(uint256 indexed campaignId, address indexed user, address indexed publisher, uint256 eventCount, uint256 ratePlanck, uint8 actionType, uint256 nonce, uint256 publisherPayment, uint256 userPayment, uint256 protocolFee)",
  "event ClaimRejected(uint256 indexed campaignId, address indexed user, uint256 nonce, uint8 reasonCode)",
  // ── DatumClickRegistry
  "event ClickRecorded(bytes32 indexed sessionHash, address indexed user, uint256 indexed campaignId)",
  // ── DatumCampaigns — demand side
  "event CampaignCreated(uint256 indexed campaignId, address indexed advertiser, address indexed publisher, uint256 totalBudgetPlanck, uint16 snapshotTakeRateBps)",
  "event CampaignActivated(uint256 indexed campaignId)",
  // ── DatumPublishers — supply side
  "event PublisherRegistered(address indexed publisher, uint16 takeRateBps)",

  // ── R1.3: DatumPaymentVault — value conservation + user-payout visibility.
  // SettlementCredited.total == publisherPayment+userPayment+protocolFee of the
  // matching ClaimSettled (same tx). Withdrawals are the DOT actually leaving the
  // vault to publishers/users/protocol; the sweep funds DatumFeeShare.
  "event SettlementCredited(address indexed publisher, address indexed user, uint256 total)",
  "event PublisherWithdrawal(address indexed publisher, uint256 amount)",
  "event UserWithdrawal(address indexed user, uint256 amount)",
  "event ProtocolWithdrawal(address indexed recipient, uint256 amount)",
  "event SweptToFeeShare(address indexed recipient, uint256 amount)",

  // ── R1.3: DATUM emission orchestration (token-plane payout loop).
  // emissionEngine + mintCoordinator are deployed on this network; the token
  // plane proper (MintAuthority/FeeShare/BootstrapPool) is NOT — so MintComputed
  // may be zero/silent until token-addresses-<net>.json exists. Indexed anyway so
  // the moment the plane lands the loop becomes measurable with no code change.
  "event MintComputed(uint256 dotPaid, uint256 rawMint, uint256 effectiveMint)",
  "event DatumMintFailed(address indexed user, address indexed publisher, address indexed advertiser, uint256 totalMint)",
];

export const iface = new Interface(EVENT_FRAGMENTS);

// topic0 -> event name, so we can cheaply skip logs we don't care about.
export const KNOWN_TOPICS = new Set(
  iface.fragments.filter((f) => f.type === "event").map((f) => iface.getEvent(f.name).topicHash),
);
