// EIP-712 ClaimBatch signing — mirrors DatumDualSigSettlement exactly.
// Domain pinned to ("DatumSettlement","1") on the DualSig contract; claimsHash =
// keccak256(abi.encodePacked(claim.claimHash …)). Independent of the relay's copy
// on purpose: this service recomputes the digest itself and never trusts a
// caller-supplied hash.
import { keccak256, concat } from "ethers";

const TYPES = {
  ClaimBatch: [
    { name: "user", type: "address" },
    { name: "campaignId", type: "uint256" },
    { name: "claimsHash", type: "bytes32" },
    { name: "deadlineBlock", type: "uint256" },
    { name: "expectedRelaySigner", type: "address" },
    { name: "expectedAdvertiserRelaySigner", type: "address" },
  ],
};

export const computeClaimsHash = (claimHashes) => keccak256(concat(claimHashes));

export function domain(chainId, dualSigAddress) {
  return { name: "DatumSettlement", version: "1", chainId, verifyingContract: dualSigAddress };
}

export async function signClaimBatch(wallet, chainId, dualSigAddress, value) {
  return wallet.signTypedData(domain(chainId, dualSigAddress), TYPES, value);
}
