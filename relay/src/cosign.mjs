// EIP-712 co-signing for the SLIM dual-sig settlement path.
//
// claimsHash mirrors DatumDualSigSettlement._hashClaims exactly:
//   keccak256( abi.encodePacked( for each claim: keccak256(abi.encode(Claim)) ) )
//   where Claim is the SLIM tuple (publisher, eventCount, rateWei, actionType,
//   ClaimProof[] proof). abi.encodePacked(bytes32[]) == concat of the 32-byte
//   per-claim hashes.
// digest signs the ClaimBatch type (incl. firstNonce) on the
//   ("DatumSettlement","1") domain whose verifyingContract is the DualSig contract.
import { keccak256, concat, ZeroHash, AbiCoder } from "ethers";
import { CLAIM_BATCH_TYPES, CLAIM_TUPLE } from "./abis.mjs";

const abiCoder = AbiCoder.defaultAbiCoder();

// Per-claim content hash: keccak256(abi.encode(Claim)). The claim must already be
// in normalized SLIM shape (see normalizeClaim).
export function hashClaim(claim) {
  return keccak256(abiCoder.encode([CLAIM_TUPLE], [claim]));
}

export function computeClaimsHash(claims) {
  return keccak256(concat(claims.map(hashClaim)));
}

export function domain(chainId, dualSigAddress) {
  return { name: "DatumSettlement", version: "1", chainId, verifyingContract: dualSigAddress };
}

// Produce a signature over the batch envelope with the given wallet.
export async function signBatch(wallet, chainId, dualSigAddress, batch, claimsHash) {
  const value = {
    user: batch.user,
    campaignId: batch.campaignId,
    firstNonce: batch.firstNonce,
    claimsHash,
    deadlineBlock: batch.deadlineBlock,
    expectedRelaySigner: batch.expectedRelaySigner,
    expectedAdvertiserRelaySigner: batch.expectedAdvertiserRelaySigner,
  };
  return wallet.signTypedData(domain(chainId, dualSigAddress), CLAIM_BATCH_TYPES, value);
}

// Normalize one ClaimProof sidecar entry to the on-chain field order/shape.
function normalizeProof(pf) {
  const arr = (v, n) => (Array.isArray(v) && v.length === n ? v : Array(n).fill(ZeroHash));
  return {
    clickSessionHash: pf?.clickSessionHash ?? ZeroHash,
    stakeRootUsed: pf?.stakeRootUsed ?? ZeroHash,
    nullifier: pf?.nullifier ?? ZeroHash,
    powNonce: pf?.powNonce ?? ZeroHash,
    zkProof: arr(pf?.zkProof, 8),
    actionSig: arr(pf?.actionSig, 3),
  };
}

// Coerce a posted claim into the SLIM on-chain Claim tuple. The optional `proof`
// sidecar carries PoW/ZK/click material (0 entries = plain view, 1 entry = the
// rest). Accepts the legacy `ratePlanck` field name as an alias for `rateWei`.
export function normalizeClaim(c) {
  const proof = Array.isArray(c.proof) ? c.proof.slice(0, 1).map(normalizeProof) : [];
  return {
    publisher: c.publisher,
    eventCount: BigInt(c.eventCount ?? 1),
    rateWei: BigInt(c.rateWei ?? c.ratePlanck),
    actionType: Number(c.actionType ?? 0),
    proof,
  };
}
