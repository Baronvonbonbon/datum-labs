// EIP-712 ClaimBatch signing — mirrors DatumDualSigSettlement exactly (SLIM).
// Domain pinned to ("DatumSettlement","1") on the DualSig contract; the ClaimBatch
// type carries firstNonce; claimsHash =
//   keccak256( concat( for each claim: keccak256(abi.encode(Claim)) ) )
// over the SLIM Claim tuple. Independent of the relay's copy on purpose: this
// service recomputes the digest itself from the full claims and never trusts a
// caller-supplied hash.
import { keccak256, concat, ZeroHash, AbiCoder } from "ethers";

const abiCoder = AbiCoder.defaultAbiCoder();

// SLIM Claim tuple (must byte-match IDatumSettlement.Claim for abi.encode).
const CLAIM_TUPLE =
  "(address publisher,uint256 eventCount,uint256 rateWei,uint8 actionType,(bytes32 clickSessionHash,bytes32 stakeRootUsed,bytes32 nullifier,bytes32 powNonce,bytes32[8] zkProof,bytes32[3] actionSig)[] proof)";

const TYPES = {
  ClaimBatch: [
    { name: "user", type: "address" },
    { name: "campaignId", type: "uint256" },
    { name: "firstNonce", type: "uint256" },
    { name: "claimsHash", type: "bytes32" },
    { name: "deadlineBlock", type: "uint256" },
    { name: "expectedRelaySigner", type: "address" },
    { name: "expectedAdvertiserRelaySigner", type: "address" },
  ],
};

const arr = (v, n) => (Array.isArray(v) && v.length === n ? v : Array(n).fill(ZeroHash));

// Coerce a posted (JSON, string-valued) claim into the SLIM on-chain shape.
export function normalizeClaim(c) {
  const proof = Array.isArray(c.proof) ? c.proof.slice(0, 1).map((pf) => ({
    clickSessionHash: pf?.clickSessionHash ?? ZeroHash,
    stakeRootUsed: pf?.stakeRootUsed ?? ZeroHash,
    nullifier: pf?.nullifier ?? ZeroHash,
    powNonce: pf?.powNonce ?? ZeroHash,
    zkProof: arr(pf?.zkProof, 8),
    actionSig: arr(pf?.actionSig, 3),
  })) : [];
  return {
    publisher: c.publisher,
    eventCount: BigInt(c.eventCount ?? 1),
    rateWei: BigInt(c.rateWei ?? c.ratePlanck),
    actionType: Number(c.actionType ?? 0),
    proof,
  };
}

export const hashClaim = (claim) => keccak256(abiCoder.encode([CLAIM_TUPLE], [claim]));
export const computeClaimsHash = (claims) => keccak256(concat(claims.map(hashClaim)));

export function domain(chainId, dualSigAddress) {
  return { name: "DatumSettlement", version: "1", chainId, verifyingContract: dualSigAddress };
}

export async function signClaimBatch(wallet, chainId, dualSigAddress, value) {
  return wallet.signTypedData(domain(chainId, dualSigAddress), TYPES, value);
}
