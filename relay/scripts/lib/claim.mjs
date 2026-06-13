// Shared claim construction — used by inject-claim.mjs (single) and load.mjs (bulk).
// Builds a valid SignedClaimBatch envelope (claimHash mirrors DatumClaimValidator's
// abi.encode preimage; mines PoW if the engine enforces it). The relay co-signs
// publisher/advertiser sigs server-side, so this only builds the unsigned envelope.
import { AbiCoder, keccak256, ZeroHash, ZeroAddress, getAddress, Contract, concat, toBeHex } from "ethers";
import { signHeaders } from "../../src/auth.mjs";

const POW_ABI = [
  "function enforcePow() view returns (bool)",
  "function powTargetForUser(address,uint256) view returns (uint256)",
];

export function freshUser() {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return getAddress("0x" + Buffer.from(b).toString("hex"));
}

// Grind powNonce s.t. keccak256(abi.encodePacked(claimHash, powNonce)) <= target.
export function grindPow(claimHash, target) {
  for (let i = 0n; ; i++) {
    const nonce = toBeHex(i, 32);
    if (BigInt(keccak256(concat([claimHash, nonce]))) <= target) return { nonce, tries: i + 1n };
  }
}

export function computeClaimHash({ campaignId, publisher, user, eventCount, ratePlanck, actionType, clickSessionHash, nonce, previousClaimHash, stakeRootUsed }) {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "address", "uint256", "uint256", "uint8", "bytes32", "uint256", "bytes32", "bytes32"],
      [campaignId, publisher, user, eventCount, ratePlanck, actionType, clickSessionHash, nonce, previousClaimHash, stakeRootUsed],
    ),
  );
}

// Build a ready-to-POST envelope. `powEngine` (address or null) gates PoW mining.
// Caller supplies a head block number to avoid an RPC per claim in bulk loops.
export function buildEnvelope({
  campaignId, publisher, user, ratePlanck, head,
  eventCount = 1n, actionType = 0, nonce = 1n, previousClaimHash = ZeroHash,
  deadlineOffset = 1000n, expectedRelaySigner = ZeroAddress, expectedAdvertiserRelaySigner = ZeroAddress,
  powTarget = null,
}) {
  const clickSessionHash = ZeroHash, stakeRootUsed = ZeroHash;
  const claimHash = computeClaimHash({ campaignId, publisher, user, eventCount, ratePlanck, actionType, clickSessionHash, nonce, previousClaimHash, stakeRootUsed });
  let powNonce = ZeroHash, powTries = 0n;
  if (powTarget != null) ({ nonce: powNonce, tries: powTries } = grindPow(claimHash, powTarget));

  const claim = {
    campaignId: campaignId.toString(), publisher, eventCount: eventCount.toString(), ratePlanck: ratePlanck.toString(),
    actionType, clickSessionHash, nonce: nonce.toString(), previousClaimHash, claimHash,
    zkProof: Array(8).fill(ZeroHash), nullifier: ZeroHash, stakeRootUsed, actionSig: Array(3).fill(ZeroHash), powNonce,
  };
  const envelope = {
    user, campaignId: campaignId.toString(), deadlineBlock: (BigInt(head) + deadlineOffset).toString(),
    userSig: "0x00", expectedRelaySigner, expectedAdvertiserRelaySigner, claims: [claim],
  };
  return { envelope, powTries };
}

// Read whether PoW is enforced + the per-user target (null if not enforced).
export async function powTarget(provider, powEngineAddr, user, eventCount) {
  if (!powEngineAddr) return null;
  const pe = new Contract(powEngineAddr, POW_ABI, provider);
  if (!(await pe.enforcePow())) return null;
  return await pe.powTargetForUser(user, eventCount);
}

// Signs the POST with RELAY_HMAC_SECRET (from env or arg) when present, so trusted
// testers can reach a tunnel-exposed relay; unsigned otherwise (open localhost).
export async function postClaim(relayUrl, envelope, secret = process.env.RELAY_HMAC_SECRET || "") {
  const body = JSON.stringify(envelope);
  const headers = { "content-type": "application/json", ...(secret ? signHeaders(secret, body) : {}) };
  const res = await fetch(`${relayUrl.replace(/\/+$/, "")}/claim`, { method: "POST", headers, body });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
