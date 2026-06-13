// Exact on-chain fragments the relay submits, verified against alpha-core
// (extension DatumSettlement.json + DatumClickRegistry.json). The Claim tuple
// here is the 14-field settleSignedClaims variant (NOT the 17-field settleClaims
// one — that path carries policyId/interestWeightBps/auctionRootCommit extras).
export const CLAIM_TUPLE =
  "(uint256 campaignId,address publisher,uint256 eventCount,uint256 rateWei,uint8 actionType,bytes32 clickSessionHash,uint256 nonce,bytes32 previousClaimHash,bytes32 claimHash,bytes32[8] zkProof,bytes32 nullifier,bytes32 stakeRootUsed,bytes32[3] actionSig,bytes32 powNonce)";

export const SIGNED_BATCH_TUPLE =
  `(address user,uint256 campaignId,${CLAIM_TUPLE}[] claims,uint256 deadlineBlock,address expectedRelaySigner,address expectedAdvertiserRelaySigner,bytes userSig,bytes publisherSig,bytes advertiserSig)`;

// Settlement custom errors so ethers can DECODE reverts (otherwise estimateGas
// reverts surface as "unknown custom error" + a raw selector, and the relay can't
// tell a terminal bad-claim from a transient failure). E80-E85 = dual-sig envelope
// (deadline / publisher sig / advertiser sig); E89 = same-key independence guard
// (publisher & advertiser sigs from one key); the rest are validator/settlement gates.
const SETTLEMENT_ERRORS = [
  "error E00()", "error E11()", "error E18()", "error E27()", "error E28()",
  "error E32()", "error E34()", "error E80()", "error E81()", "error E82()",
  "error E83()", "error E84()", "error E85()", "error E89()", "error Paused()", "error OnlyDualSig()",
];
export const DUALSIG_ABI = [`function settleSignedClaims(${SIGNED_BATCH_TUPLE}[] batches)`, ...SETTLEMENT_ERRORS];

export const CLICK_ABI = ["function recordClick(address user, uint256 campaignId, bytes32 impressionNonce)"];

export const PUBLISHERS_ABI = ["function relaySigner(address publisher) view returns (address)"];

// Read-only: resolve a campaign's advertiser so the relay can route to the right
// per-advertiser co-signer (interim, until the on-chain advertiser profile registry).
export const CAMPAIGNS_ABI = ["function getCampaignAdvertiser(uint256 campaignId) view returns (address)"];

// DatumPaymentVault — gasless withdrawal (staged; needs a vault with withdrawUserBySig).
export const PAYMENT_VAULT_ABI = [
  "function withdrawUserBySig(address user, address recipient, uint256 maxFee, uint256 deadline, bytes sig)",
  "function withdrawNonce(address) view returns (uint256)",
  "function userBalance(address) view returns (uint256)",
  "function domainSeparator() view returns (bytes32)",
];

// EIP-712 types a client signs for withdrawUserBySig. Domain:
// { name:"DatumPaymentVault", version:"1", chainId, verifyingContract: <vault> }.
export const WITHDRAW_AUTH_TYPES = {
  WithdrawAuth: [
    { name: "user", type: "address" },
    { name: "recipient", type: "address" },
    { name: "maxFee", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

// EIP-712 — domain pinned to ("DatumSettlement","1") on the DualSig contract;
// type mirrors DatumDualSigSettlement.CLAIM_BATCH_TYPEHASH exactly.
export const CLAIM_BATCH_TYPES = {
  ClaimBatch: [
    { name: "user", type: "address" },
    { name: "campaignId", type: "uint256" },
    { name: "claimsHash", type: "bytes32" },
    { name: "deadlineBlock", type: "uint256" },
    { name: "expectedRelaySigner", type: "address" },
    { name: "expectedAdvertiserRelaySigner", type: "address" },
  ],
};
