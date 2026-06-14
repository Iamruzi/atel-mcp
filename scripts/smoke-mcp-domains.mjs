#!/usr/bin/env node
// Comprehensive MCP tool audit — exercises one+ tool per domain end to
// end, reports gaps. Hits the deployed MCP server with a real JWT
// derived from lobster1's identity.

import fs from "node:fs";
import crypto from "node:crypto";
import nacl from "tweetnacl";

const MCP = process.argv[2] || "http://144.202.53.72:8787";
const PLAT = process.argv[3] || "http://144.202.53.72:8200";
const ID = process.argv[4] || "/root/atel-workspace/.atel/identity.json";

function ser(o) { return JSON.stringify(o, (_k, v) => {
  if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)) {
    const s = {}; for (const k of Object.keys(v).sort()) s[k] = v[k]; return s;
  }
  return v;
});}
function dec(s) {
  if (/^[0-9a-f]+$/i.test(s) && s.length === 128) return Buffer.from(s, "hex");
  return Buffer.from(s, "base64");
}

const id = JSON.parse(fs.readFileSync(ID, "utf8"));
const sk = dec(id.secretKey);

async function getToken() {
  const ts = new Date().toISOString();
  const payload = { nonce: crypto.randomBytes(16).toString("hex") };
  const signable = ser({ payload, did: id.did, timestamp: ts });
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(signable), sk)).toString("base64");
  const r = await fetch(`${PLAT}/auth/v1/did-sig`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: id.did, payload, timestamp: ts, signature: sig }),
  });
  const j = await r.json();
  if (!j.token) throw new Error(`did-sig: ${JSON.stringify(j)}`);
  return j.token;
}

let nextId = 1;
async function call(token, name, args = {}) {
  const r = await fetch(`${MCP}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await r.text();
  // Strip SSE framing if present
  let body = text;
  const dataLine = text.match(/^data: (.*)$/m);
  if (dataLine) body = dataLine[1];
  try {
    const j = JSON.parse(body);
    const inner = j?.result?.content?.[0]?.text;
    let parsed = inner;
    try { parsed = JSON.parse(inner); } catch {}
    return { http: r.status, isError: j?.result?.isError ?? false, result: parsed, raw: j };
  } catch {
    return { http: r.status, parseError: true, body: body.slice(0, 200) };
  }
}

const TESTS = [
  // Identity / auth
  ["atel_whoami", {}],
  ["atel_runtime_link_status", {}],
  ["atel_agent_search", { query: "lobster" }],

  // Wallet (read)
  ["atel_balance", {}],
  ["atel_deposit_info", {}],
  ["atel_wallet_status", {}],

  // Fast Network (read)
  ["atel_fast_balance", {}],
  ["atel_fast_deposit_address", {}],

  // Messaging
  ["atel_inbox_list", {}],
  ["atel_contacts_list", {}],

  // Order/milestone (read)
  ["atel_order_list", { role: "requester", status: "settled" }],

  // Audit
  ["atel_audit_session_get", {}],

  // Approval
  ["atel_approval_list", {}],

  // A2B
  ["atel_a2b_countries", {}],
  ["atel_a2b_search", { country: "US", query: "amazon", limit: 3 }],
  ["atel_a2b_purchase_list", {}],

  // Dispute
  ["atel_dispute_list", {}],
];

console.log("Acquiring DID-Sig JWT…");
const token = await getToken();
console.log("token len=", token.length);
console.log();

const results = [];
for (const [name, args] of TESTS) {
  process.stdout.write(`${name.padEnd(38)} `);
  let r;
  try { r = await call(token, name, args); }
  catch (e) { r = { error: e.message }; }
  let status;
  if (r?.error) status = `THREW: ${r.error.slice(0, 80)}`;
  else if (r?.parseError) status = `PARSE_ERR http=${r.http} body=${r.body}`;
  else if (r?.isError) {
    const code = r.result?.code || "ERR";
    const msg = r.result?.message?.slice(0, 80) || "";
    status = `❌ ${code}: ${msg}`;
  } else {
    let summary = "";
    if (typeof r.result === "object") {
      const keys = Object.keys(r.result || {}).slice(0, 6).join(",");
      summary = `keys=${keys}`;
    } else if (typeof r.result === "string") {
      summary = `str(${r.result.length})`;
    }
    status = `✅ ${summary}`;
  }
  console.log(status);
  results.push({ name, status });
}
console.log();
console.log("Summary:");
const passed = results.filter(r => r.status.startsWith("✅")).length;
const failed = results.length - passed;
console.log(`  ${passed}/${results.length} passed, ${failed} failed`);
