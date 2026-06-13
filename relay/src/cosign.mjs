// EIP-712 co-signing for the dual-sig settlement path.
//
// claimsHash = keccak256(abi.encodePacked(claim.claimHash for each claim))
//   — matches DatumDualSigSettlement._hashClaims exactly.
// digest signs the ClaimBatch type on the ("DatumSettlement","1") domain
//   whose verifyingContract is the DualSig contract.
import { keccak256, concat, ZeroHash } from "ethers";
import { CLAIM_BATCH_TYPES } from "./abis.mjs";

export function computeClaimsHash(claims) {
  return keccak256(concat(claims.map((c) => c.claimHash)));
}

export function domain(chainId, dualSigAddress) {
  return { name: "DatumSettlement", version: "1", chainId, verifyingContract: dualSigAddress };
}

// Produce a signature over the batch envelope with the given wallet.
export async function signBatch(wallet, chainId, dualSigAddress, batch, claimsHash) {
  const value = {
    user: batch.user,
    campaignId: batch.campaignId,
    claimsHash,
    deadlineBlock: batch.deadlineBlock,
    expectedRelaySigner: batch.expectedRelaySigner,
    expectedAdvertiserRelaySigner: batch.expectedAdvertiserRelaySigner,
  };
  return wallet.signTypedData(domain(chainId, dualSigAddress), CLAIM_BATCH_TYPES, value);
}

// Fill the optional ZK / stake / pow fields of a posted claim with zeros so a
// plain CPM lab claim is a valid on-chain Claim tuple. Required fields must be
// present already (campaignId, publisher, eventCount, rateWei, claimHash).
export function normalizeClaim(c) {
  return {
    campaignId: BigInt(c.campaignId),
    publisher: c.publisher,
    eventCount: BigInt(c.eventCount ?? 1),
    rateWei: BigInt(c.rateWei),
    actionType: Number(c.actionType ?? 0),
    clickSessionHash: c.clickSessionHash ?? ZeroHash,
    nonce: BigInt(c.nonce ?? 0),
    previousClaimHash: c.previousClaimHash ?? ZeroHash,
    claimHash: c.claimHash,
    zkProof: c.zkProof ?? Array(8).fill(ZeroHash),
    nullifier: c.nullifier ?? ZeroHash,
    stakeRootUsed: c.stakeRootUsed ?? ZeroHash,
    actionSig: c.actionSig ?? Array(3).fill(ZeroHash),
    powNonce: c.powNonce ?? ZeroHash,
  };
}
