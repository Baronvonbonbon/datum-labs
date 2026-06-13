// Campaign creation core — shared by create-campaign.mjs and scenario.mjs.
// Ensures advertiser stake, creates a single-view-pot campaign, and admin-activates it.
import { Contract, ZeroAddress } from "ethers";
import { send } from "./tx.mjs";

const CAMP_ABI = [
  "function createCampaign(address publisher, (uint8 actionType,uint256 budgetPlanck,uint256 dailyCapPlanck,uint256 ratePlanck,address actionVerifier)[] pots, bytes32[] requiredTags, bool requireZkProof, address rewardToken, uint256 rewardPerImpression, uint256 bondAmount) payable returns (uint256)",
  "function nextCampaignId() view returns (uint256)",
  "function getCampaignForSettlement(uint256) view returns (uint8,address,uint16)",
];
const STAKE_ABI = [
  "function isAdequatelyStaked(address) view returns (bool)",
  "function requiredStake(address) view returns (uint256)",
  "function staked(address) view returns (uint256)",
  "function stake() payable",
];
const ROUTER_ABI = ["function adminActivateCampaign(uint256 campaignId)"];

// advertiser + admin are connected Wallets. Returns { cid, active }.
export async function createAndActivate({ ADDR, advertiser, admin, publisher, budgetPlanck, dailyCapPlanck, bidPlanck, log = console.log }) {
  // 1. advertiser stake
  const stake = new Contract(ADDR.advertiserStake, STAKE_ABI, advertiser);
  if (!(await stake.isAdequatelyStaked(advertiser.address))) {
    const top = (await stake.requiredStake(advertiser.address)) - (await stake.staked(advertiser.address));
    log(`  staking ${top} planck for advertiser…`);
    await send("stake", advertiser, stake.stake({ value: top }));
  }

  // 2. createCampaign — single view pot, no tags (bound to publisher), no bond.
  const campaigns = new Contract(ADDR.campaigns, CAMP_ABI, advertiser);
  const pots = [{ actionType: 0, budgetPlanck, dailyCapPlanck: dailyCapPlanck ?? budgetPlanck, ratePlanck: bidPlanck, actionVerifier: ZeroAddress }];
  const cid = await campaigns.nextCampaignId();
  await send(`createCampaign #${cid}`, advertiser, campaigns.createCampaign(publisher, pots, [], false, ZeroAddress, 0n, 0n, { value: budgetPlanck }));

  // 3. admin activation
  const router = new Contract(ADDR.governanceRouter, ROUTER_ABI, admin);
  await send(`activate #${cid}`, admin, router.adminActivateCampaign(cid));

  const [status] = await campaigns.getCampaignForSettlement(cid);
  return { cid, active: Number(status) === 1 };
}
