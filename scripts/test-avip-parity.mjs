#!/usr/bin/env node
// Regression test: MCP-driven order_create reaches AVIP-FULFILLED at
// settle. Runs the full create→accept→plan→milestones→settle path
// and verifies platform's completion_proofs row matches expectations.
//
// Why this matters: MCP must produce orders byte-equivalent to SDK CLI
// (same TaskRequest signing, same Intent envelope). If a future change
// regresses the signing canonical or strips the intent field, this
// test catches it before deploy.
//
// Usage:
//   node scripts/test-avip-parity.mjs <mcpBaseUrl> <platformBaseUrl> <identityPath> <executorDid>
//
// Example (testnet):
//   node scripts/test-avip-parity.mjs \
//     http://144.202.53.72:8787 \
//     http://144.202.53.72:8200 \
//     /root/atel-workspace/.atel/identity.json \
//     did:atel:ed25519:9MG292qspkEZpgSfMbTYgY9FJT29S1ueaBHJ7xzpbD3K
//
// Exit code: 0 on FULFILLED, 1 on any other verdict or timeout.

import fs from "node:fs";
import crypto from "node:crypto";
import nacl from "tweetnacl";

const [, , MCP, PLAT, ID, EXEC, CAP_ARG] = process.argv;
if (!MCP || !PLAT || !ID || !EXEC) {
  console.error("usage: test-avip-parity.mjs <mcpBaseUrl> <platformBaseUrl> <identityPath> <executorDid> [capability=coding]");
  process.exit(2);
}
const CAP = CAP_ARG || "coding";

function ser(o){return JSON.stringify(o,(_,v)=>{if(v!==null&&typeof v==="object"&&!Array.isArray(v)&&!(v instanceof Uint8Array)){const s={};for(const k of Object.keys(v).sort())s[k]=v[k];return s}return v})}
function dec(s){if(/^[0-9a-f]+$/i.test(s)&&s.length===128)return Buffer.from(s,"hex");return Buffer.from(s,"base64")}

const id = JSON.parse(fs.readFileSync(ID, "utf8"));
const sk = dec(id.secretKey);
const description = `AVIP regression test ${new Date().toISOString()} — write a one-line poem about distributed systems`;

async function getToken() {
  const ts = new Date().toISOString();
  const payload = { nonce: crypto.randomBytes(16).toString("hex") };
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(ser({payload, did:id.did, timestamp:ts})), sk)).toString("base64");
  const r = await fetch(`${PLAT}/auth/v1/did-sig`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ did:id.did, payload, timestamp:ts, signature:sig }),
  });
  return (await r.json()).token;
}

function buildTaskRequest(executorDid, capability, description) {
  const tr = {
    version: 2,
    orderId: null,
    taskId: `task-${crypto.randomBytes(12).toString("hex")}`,
    requesterDid: id.did,
    executorDid,
    capability,
    description,
    payload: { description },
    timestamp: new Date().toISOString(),
  };
  // Canonical signable: explicit alphabetical key order, EXCLUDES orderId.
  // Must match platform's verifyTaskSignature (helpers.go).
  const signable = JSON.stringify({
    capability: tr.capability, description: tr.description, executorDid: tr.executorDid,
    payload: tr.payload, requesterDid: tr.requesterDid, taskId: tr.taskId,
    timestamp: tr.timestamp, version: tr.version,
  });
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(signable), sk)).toString("base64");
  return { taskRequest: tr, taskSignature: sig };
}

function buildIntent(executorDid, priceUsdc) {
  const ts = new Date().toISOString();
  const constraints = { maxAmount: priceUsdc, milestoneCount: 5 };
  const signable = ser({
    action: "execute_task", constraints,
    issuerDid: id.did, subjectDid: executorDid, timestamp: ts,
  });
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(signable), sk)).toString("base64");
  return {
    intentId: "intent_" + crypto.randomUUID(),
    issuerDid: id.did, subjectDid: executorDid, action: "execute_task",
    constraints,
    delegationChain: [{ from: id.did, to: executorDid, attenuated: true, signature: sig }],
    timestamp: ts, signature: sig,
  };
}

async function callMcp(token, name, args) {
  const r = await fetch(`${MCP}/mcp`, {
    method: "POST",
    headers: { "content-type":"application/json", "accept":"application/json, text/event-stream", "authorization":`Bearer ${token}` },
    body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"tools/call", params:{name, arguments:args} }),
  });
  const text = await r.text();
  const dl = text.match(/^data: (.*)$/m);
  const j = JSON.parse(dl ? dl[1] : text);
  const inner = j?.result?.content?.[0]?.text;
  return JSON.parse(inner);
}

async function pollOrder(token, orderId, timeoutMs = 600_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const o = await callMcp(token, "atel_order_get", { orderId });
      if (o.Status === "settled") return o;
      process.stdout.write(`  [${new Date().toLocaleTimeString()}] status=${o.Status}\n`);
    } catch (e) {
      console.warn(`  poll error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 15000));
  }
  throw new Error(`timed out waiting for settle (>${timeoutMs}ms)`);
}

console.log("AVIP parity regression test");
console.log("  requester:", id.did);
console.log("  executor: ", EXEC);
console.log("  desc:    ", description);
console.log();

const token = await getToken();
console.log("✓ DID-Sig → JWT (len", token.length, ")");

const { taskRequest, taskSignature } = buildTaskRequest(EXEC, CAP, description);
const intent = buildIntent(EXEC, 0.001);
console.log("✓ AVIP envelope built (taskId=" + taskRequest.taskId + ", intentId=" + intent.intentId + ")");

const create = await callMcp(token, "atel_order_create", {
  executorDid: EXEC, capabilityType: CAP, description, priceUsdc: 0.001,
  version: 2, taskRequest, taskSignature, intent,
});
if (!create.orderId) {
  console.error("✗ create failed:", JSON.stringify(create));
  process.exit(1);
}
const orderId = create.orderId;
console.log("✓ Order created:", orderId);

console.log("Waiting for settle…");
const finalOrder = await pollOrder(token, orderId);
console.log("✓ Settled at", finalOrder.SettledAt || finalOrder.settledAt || "?");

// Now check platform DB directly via API for completion_proof
const proofResp = await fetch(`${PLAT}/trade/v1/order/${encodeURIComponent(orderId)}/completion-proof`);
if (!proofResp.ok) {
  console.error(`✗ completion-proof endpoint returned ${proofResp.status}`);
  process.exit(1);
}
const proof = await proofResp.json();
console.log();
console.log("CompletionProof:");
console.log(`  verdict:         ${proof.verdict}`);
console.log(`  ratio:           ${proof.milestones_completed}/${proof.milestones_expected}`);
console.log(`  within_budget:   ${proof.within_budget}`);
console.log(`  within_scope:    ${proof.within_scope}`);
console.log(`  within_deadline: ${proof.within_deadline}`);
console.log(`  anchor_status:   ${proof.anchor_status}`);
console.log();

const ok = proof.verdict === "FULFILLED"
  && proof.within_budget === true
  && proof.within_scope === true
  && proof.within_deadline === true;
if (ok) {
  console.log("✅ PASS — AVIP parity verified");
  process.exit(0);
}
console.error("❌ FAIL — verdict not FULFILLED or constraints not met");
process.exit(1);
