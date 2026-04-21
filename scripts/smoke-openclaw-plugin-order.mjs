import { callTool, createTool, waitForMilestonePhase } from "./openclaw-plugin-smoke-lib.mjs";

function milestoneResult(index) {
  if (index === 0) {
    return [
      "Gold trend scope is current-to-near-term.",
      "Core drivers are USD, yields, and risk sentiment.",
      "Final output must be exactly 3 short sentences.",
    ].join("\n");
  }
  return [
    "Gold is holding a high but choppy range in the near term.",
    "Safe-haven demand and softer rate expectations keep the broader bias constructive.",
    "A stronger dollar or yield rebound is still the main short-term drag.",
  ].join("\n");
}

async function main() {
  const requesterTool = createTool("ATEL_PLUGIN_REQUESTER_IDENTITY_PATH");
  const executorDid = process.env.ATEL_PLUGIN_EXECUTOR_DID;
  if (!executorDid) {
    throw new Error("Missing required env: ATEL_PLUGIN_EXECUTOR_DID");
  }

  const createResult = await callTool(requesterTool, "atel_order_create", {
    executorDid,
    capabilityType: process.env.ATEL_PLUGIN_CAPABILITY_TYPE ?? "general",
    description: `plugin smoke order ${Date.now()}: summarize gold trend in exactly 3 short sentences`,
    priceUsdc: Number(process.env.ATEL_PLUGIN_PRICE_USDC ?? "0"),
    chain: process.env.ATEL_PLUGIN_CHAIN ?? "base",
  });
  const orderId = String(createResult?.structuredContent?.orderId ?? createResult?.orderId ?? "").trim();
  if (!orderId) {
    throw new Error(`Missing orderId from create result: ${JSON.stringify(createResult)}`);
  }

  const firstPhase = await (async () => {
    let last = null;
    for (let i = 0; i < 40; i += 1) {
      last = await callTool(requesterTool, "atel_milestone_list", { orderId });
      const phase = String(last?.phase ?? "").toLowerCase();
      if (phase === "waiting_requester_verification" || phase === "waiting_executor_submission") {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return last;
  })();

  const firstPhaseName = String(firstPhase?.phase ?? "").toLowerCase();
  if (firstPhaseName !== "waiting_requester_verification" && firstPhaseName !== "waiting_executor_submission") {
    throw new Error(`Unexpected initial phase: ${JSON.stringify(firstPhase)}`);
  }
  if (firstPhaseName === "waiting_executor_submission") {
    console.log(JSON.stringify({
      ok: true,
      mode: "requester-only-pending",
      orderId,
      createResult,
      firstPhase,
      expectedSamples: {
        milestone0: milestoneResult(0),
        milestone1: milestoneResult(1),
      },
    }, null, 2));
    return;
  }

  const verifyResult = await callTool(requesterTool, "atel_milestone_verify", {
    orderId,
    index: 0,
    approved: true,
  });
  const afterVerify = await waitForMilestonePhase(requesterTool, orderId, "waiting_executor_submission");
  const finalMilestones = await waitForMilestonePhase(requesterTool, orderId, "waiting_requester_verification", 40);
  const milestoneItems = Array.isArray(finalMilestones?.milestones) ? finalMilestones.milestones : [];
  const m1Status = String(milestoneItems[1]?.status ?? "").toLowerCase();

  console.log(JSON.stringify({
    ok: true,
    mode: "requester-only-verified",
    orderId,
    createResult,
    firstPhase,
    verifyResult,
    afterVerify,
    finalMilestones,
    milestone1Status: m1Status,
    expectedSamples: {
      milestone0: milestoneResult(0),
      milestone1: milestoneResult(1),
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});

