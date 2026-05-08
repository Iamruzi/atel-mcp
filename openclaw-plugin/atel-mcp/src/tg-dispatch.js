// Telegram card dispatcher.
//
// The plugin listener receives every platform push event (order_*,
// milestone_*, settled, ...). Instead of relying on the cron-driven
// agent to format and emit a notification card via assistant text
// (fragile — LLMs habitually narrate, leaking reasoning into TG), we
// format and send the card here, deterministically, the moment the
// event arrives.
//
// This is the same canonical format the official atel-tg-bot uses
// (relay-poller.ts in atel-tg-bot). The cron agent's job becomes pure
// state mutation (accept order, plan-approve, submit milestone,
// verify) — its assistant text is suppressed at the cron-delivery
// layer (delivery.mode=none). Concerns are cleanly separated: action
// vs. notification.

import fs from "node:fs";
import path from "node:path";

let cachedToken = null;
let cachedChat = null;
let cachedConfigPath = null;
const recentDispatches = new Map(); // dedupeKey -> ms

function loadOpenClawConfig(configPath) {
  if (cachedConfigPath === configPath && cachedToken !== null) {
    return { token: cachedToken };
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    let raw = cfg?.channels?.telegram?.botToken || "";
    if (raw.startsWith("${") && raw.endsWith("}")) {
      const envName = raw.slice(2, -1);
      raw = process.env[envName] || "";
    }
    cachedToken = raw;
    cachedConfigPath = configPath;
    return { token: raw };
  } catch {
    return { token: "" };
  }
}

function readChatIdFromSideChannel(extensionDir) {
  if (cachedChat !== null) return cachedChat;
  // 1. env var wins
  if (process.env.ATEL_USER_TG_CHAT) {
    cachedChat = String(process.env.ATEL_USER_TG_CHAT);
    return cachedChat;
  }
  // 2. atel-state.json (modern, atomic; install.js writes here)
  try {
    const stateFile = path.join(extensionDir, "atel-state.json");
    if (fs.existsSync(stateFile)) {
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (typeof st?.tgChat === "string" && st.tgChat) {
        cachedChat = st.tgChat;
        return cachedChat;
      }
    }
  } catch {}
  // 3. legacy tg-chat.txt fallback
  try {
    const p = path.join(extensionDir, "tg-chat.txt");
    if (fs.existsSync(p)) {
      cachedChat = fs.readFileSync(p, "utf8").trim();
      return cachedChat;
    }
  } catch {}
  // 3. fall back to OpenClaw session lastRoute (best-effort)
  try {
    const sessions = path.join(process.env.HOME || "/root", ".openclaw", "agents", "main", "sessions", "sessions.json");
    if (fs.existsSync(sessions)) {
      const txt = fs.readFileSync(sessions, "utf8");
      const m = txt.match(/telegram:(\d+)/);
      if (m) {
        cachedChat = m[1];
        return cachedChat;
      }
    }
  } catch {}
  return "";
}

function shortOrderTag(orderId) {
  return `[${(orderId || "").slice(0, 14)}]`;
}

function previewContent(s, max = 250) {
  if (!s) return "";
  s = String(s).trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// Determine whether the recipient is the requester or executor of this
// order. Used to choose perspective-aware card text. Returns
// 'requester' | 'executor' | null when ambiguous.
function recipientRole(targetDid, payload) {
  if (!targetDid) return null;
  if (payload?.requesterDid === targetDid || payload?.requester_did === targetDid) return "requester";
  if (payload?.executorDid === targetDid || payload?.executor_did === targetDid) return "executor";
  return null;
}

// Build a canonical TG card text. Returns null if the event is not one
// we surface to the user from this perspective. Card text is chosen
// based on whether the recipient is the requester or executor of the
// order so the wording reads naturally on each side.
function buildCard(event, payload, targetDid) {
  const orderId = payload?.orderId || payload?.order_id || "";
  const tag = shortOrderTag(orderId);
  const role = recipientRole(targetDid, payload); // requester | executor | null
  switch (event) {
    case "order_created":
      // Only the executor receives this push — fresh-offer notification.
      return `${tag} 📥 收到新订单\n\n订单: ${orderId}\n描述: ${previewContent(payload?.description, 200)}\n预算: ${payload?.priceAmount ?? "?"} ${payload?.priceCurrency ?? "USD"}`;
    case "order_accepted":
      // Both parties receive this push. Wording differs.
      if (role === "executor") {
        return `${tag} 📥 已接受订单\n\n订单: ${orderId}`;
      }
      // Default / requester perspective.
      return `${tag} ✅ 订单已被接受\n\n订单: ${orderId}`;
    case "milestone_plan_proposed":
    case "milestone_plan_confirmed":
    case "milestones_proposed":
      // Plan confirmation is symmetric — same wording for both sides.
      return `${tag} 📋 里程碑计划已确认\n\n订单: ${orderId}`;
    case "milestone_submitted": {
      // Only the requester receives this push (they need to verify).
      const idx = payload?.milestoneIndex ?? payload?.index ?? "?";
      const body = previewContent(payload?.resultSummary || payload?.deliverable || payload?.content, 250);
      return `${tag} 📋 里程碑 #${idx} 已提交\n\n订单: ${orderId}\n内容:\n${body}`;
    }
    case "milestone_verified": {
      const idx = payload?.milestoneIndex ?? payload?.index ?? "?";
      // Different wording per role:
      //   - requester ran the verify, they want to confirm "我已通过 #N"
      //   - executor's work was approved, they see "你的 #N 已通过"
      if (role === "requester") {
        return `${tag} ✅ 已验收里程碑 #${idx}\n\n订单: ${orderId}`;
      }
      if (role === "executor") {
        return `${tag} ✅ 你的里程碑 #${idx} 已通过验收\n\n订单: ${orderId}`;
      }
      return `${tag} ✅ 里程碑 #${idx} 已通过\n\n订单: ${orderId}`;
    }
    case "milestone_rejected": {
      const idx = payload?.milestoneIndex ?? payload?.index ?? "?";
      const reason = previewContent(payload?.feedback || payload?.reason, 200);
      if (role === "executor") {
        return `${tag} ❌ 你的里程碑 #${idx} 被打回\n\n订单: ${orderId}\n反馈: ${reason}`;
      }
      return `${tag} ❌ 里程碑 #${idx} 被打回\n\n订单: ${orderId}\n反馈: ${reason}`;
    }
    case "order_completed":
    case "order_settled":
      if (role === "executor") {
        return `${tag} 💰 订单已结算\n\n订单: ${orderId}\n资金已到账。`;
      }
      // Default / requester perspective.
      return `${tag} 💰 订单已结算\n\n订单: ${orderId}\n资金已转给执行方。`;
    default:
      return null;
  }
}

async function sendTg(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`tg ${res.status}: ${body.slice(0, 200)}`);
  }
}

export async function dispatchEvent(messageBody, opts) {
  // messageBody is the relay payload as platform sends it. Shape from
  // 2026-05-06 capture:
  //   { dedupeKey, event, eventType, orderId, payload, ... }
  const eventType = messageBody?.event || messageBody?.eventType || "";
  const payload = messageBody?.payload || messageBody;
  const targetDid = opts?.targetDid || messageBody?.target_did || messageBody?.targetDid;
  const card = buildCard(eventType, payload, targetDid);
  if (!card) return; // silent for events we don't surface

  // Dedup: platform retries on push failure. Same dedupeKey within 5
  // minutes → skip (we already sent a card).
  const dedupe = messageBody?.dedupeKey || `${eventType}:${payload?.orderId}:${payload?.milestoneIndex ?? ""}`;
  const now = Date.now();
  const seen = recentDispatches.get(dedupe);
  if (seen && now - seen < 300_000) return;
  recentDispatches.set(dedupe, now);
  // Cap memory.
  if (recentDispatches.size > 500) {
    const oldest = [...recentDispatches.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) recentDispatches.delete(oldest[0]);
  }

  const configPath = opts?.openclawConfigPath || path.join(process.env.HOME || "/root", ".openclaw", "openclaw.json");
  const extensionDir = opts?.extensionDir || path.dirname(new URL(import.meta.url).pathname);
  const { token } = loadOpenClawConfig(configPath);
  const chatId = readChatIdFromSideChannel(path.resolve(extensionDir, ".."));
  if (!token || !chatId) {
    console.warn(`[atel-mcp/tg-dispatch] missing ${!token ? "bot token" : ""} ${!chatId ? "chat id" : ""}; skipping card for ${eventType}`);
    return;
  }
  try {
    await sendTg(token, chatId, card);
    console.log(`[atel-mcp/tg-dispatch] sent event=${eventType} order=${payload?.orderId || "?"} chars=${card.length}`);
  } catch (e) {
    console.warn(`[atel-mcp/tg-dispatch] send failed event=${eventType}: ${e && e.message}`);
  }
}
