import { callTool, createTool, waitForMilestonePhase } from "./openclaw-plugin-smoke-lib.mjs";

async function main() {
  const requesterTool = createTool("ATEL_PLUGIN_REQUESTER_IDENTITY_PATH");
  const executorDid = process.env.ATEL_PLUGIN_EXECUTOR_DID;
  if (!executorDid) {
    throw new Error("Missing required env: ATEL_PLUGIN_EXECUTOR_DID");
  }

  const createResult = await callTool(requesterTool, "atel_order_create", {
    executorDid,
    capabilityType: process.env.ATEL_PLUGIN_CAPABILITY_TYPE ?? "general",
    description: `plugin smoke dispute ${Date.now()}: explain whether gold is range-bound in one short paragraph`,
    priceUsdc: Number(process.env.ATEL_PLUGIN_PRICE_USDC ?? "0"),
    chain: process.env.ATEL_PLUGIN_CHAIN ?? "base",
  });
  const orderId = String(createResult?.structuredContent?.orderId ?? createResult?.orderId ?? "").trim();
  if (!orderId) {
    throw new Error(`Missing orderId from create result: ${JSON.stringify(createResult)}`);
  }

  const milestones = await waitForMilestonePhase(requesterTool, orderId, "waiting_requester_verification", 40);
  const milestoneItems = Array.isArray(milestones?.milestones) ? milestones.milestones : [];
  const m0Status = String(milestoneItems[0]?.status ?? "").toLowerCase();
  if (m0Status !== "submitted") {
    throw new Error(`Expected auto-submitted M0 before dispute, got ${m0Status}: ${JSON.stringify(milestones)}`);
  }

  const disputeResult = await callTool(requesterTool, "atel_dispute_create", {
    orderId,
    reason: process.env.ATEL_PLUGIN_DISPUTE_REASON ?? "quality",
    description: process.env.ATEL_PLUGIN_DISPUTE_DESCRIPTION ?? "plugin dispute smoke after initial milestone submission",
  });
  const disputeId = String(disputeResult?.structuredContent?.disputeId ?? disputeResult?.disputeId ?? "").trim();
  if (!disputeId) {
    throw new Error(`Missing disputeId from dispute result: ${JSON.stringify(disputeResult)}`);
  }

  const disputeDetail = await callTool(requesterTool, "atel_dispute_get", { disputeId });
  const disputeList = await callTool(requesterTool, "atel_dispute_list", {});
  const order = await callTool(requesterTool, "atel_order_get", { orderId });

  console.log(JSON.stringify({
    ok: true,
    orderId,
    disputeId,
    createResult,
    milestones,
    disputeResult,
    disputeDetail,
    disputeList,
    order,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});

