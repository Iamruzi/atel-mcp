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
let cachedConfigPath = null;

// 2026-05-13 fix: cachedChat used to be a string-or-null that was set ONCE
// at process startup from sessions.json and never re-read. When a user
// switched TG accounts (or merely paired a new bot), the listener kept
// dispatching to the old chat forever — 哆啦弟 case: listener pid 961232
// up 1d11h44m, cached old chat 5794244006 which the user had blocked,
// so every card died with TG 403 Forbidden. Restarting fixed it, but
// requiring a restart on every chat-binding change is fragile. Now the
// cache has a 5-minute TTL so chat-id changes propagate automatically.
let cachedChatEntry = null; // { value, ts } | null
const CHAT_CACHE_TTL_MS = 5 * 60 * 1000;

// 2026-05-13 fix: track chats that hard-rejected our messages with TG 403
// (user blocked the bot, group kicked the bot, chat deleted, etc.). These
// are PERMANENT errors at the chat level — retrying just wastes API quota
// and the operator's eyeballs reading repeating "send failed" log lines.
// Persisted in-memory only; cleared on listener restart so a re-paired
// user (block → unblock → re-DM) gets cards again after the cachedChat
// TTL refresh picks them up.
const blockedChats = new Set();

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

function resolveChatIdRaw(extensionDir) {
  // Returns CSV string of chat_ids. Read order, first match wins:
  //   1. ATEL_USER_TG_CHAT env var (operator override / broadcast set)
  //   2. atel-state.json .tgChat (install.js wrote this when --tg-chat was passed)
  //   3. tg-chat.txt (legacy single-file)
  //   4. sessions.json — collect ALL telegram:CHAT_ID matches so every
  //      paired chat sees the cards (was: only first match)
  if (process.env.ATEL_USER_TG_CHAT) {
    return String(process.env.ATEL_USER_TG_CHAT);
  }
  try {
    const stateFile = path.join(extensionDir, "atel-state.json");
    if (fs.existsSync(stateFile)) {
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (typeof st?.tgChat === "string" && st.tgChat) return st.tgChat;
    }
  } catch {}
  try {
    const p = path.join(extensionDir, "tg-chat.txt");
    if (fs.existsSync(p)) {
      const v = fs.readFileSync(p, "utf8").trim();
      if (v) return v;
    }
  } catch {}
  try {
    const sessions = path.join(process.env.HOME || "/root", ".openclaw", "agents", "main", "sessions", "sessions.json");
    if (fs.existsSync(sessions)) {
      const txt = fs.readFileSync(sessions, "utf8");
      const all = [...new Set([...txt.matchAll(/telegram:(\d+)/g)].map(m => m[1]))];
      if (all.length > 0) return all.join(",");
    }
  } catch {}
  return "";
}

function readChatIdFromSideChannel(extensionDir) {
  const now = Date.now();
  if (cachedChatEntry && now - cachedChatEntry.ts < CHAT_CACHE_TTL_MS) {
    return cachedChatEntry.value;
  }
  const fresh = resolveChatIdRaw(extensionDir);
  cachedChatEntry = { value: fresh, ts: now };
  return fresh;
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

  // P2P chat message — kind=text/general from atel_send_message. The
  // platform pushes the message body verbatim; we surface as a card so
  // the recipient sees it without hitting their inbox manually.
  const kind = payload?.kind || event;
  if (kind === "text" || kind === "general" || (event === "" && payload?.text)) {
    const text = payload?.text || "";
    if (text.trim()) {
      // Sender-name resolution mirrors the SDK / official-bot path:
      // prefer the friendly name platform attaches as `from_name`, fall
      // back to a DID tail. Showing "…<12-char tail>" is unfriendly when
      // a real label is available.
      const senderName = payload?.from_name || payload?.fromName;
      const senderDid = payload?.from_did || payload?.fromDid || payload?.senderDid || payload?.from || "";
      const senderLabel = senderName || (senderDid ? `…${senderDid.slice(-12)}` : "?");
      return `📨 新消息（来自 ${senderLabel})\n\n${text.slice(0, 500)}`;
    }
  }

  // Inbound transfer (Fast P2P / EVM wallet_transfer). Platform pushes
  // a transfer_received notification when balance updates land for the
  // recipient DID. Field names match SDK / official-bot path: snake_case
  // (`from_name`, `from_did`, `tx_hash`) — that's what platform's
  // notifyAgent emits, see internal/trade/handler.go.
  if (kind === "transfer_received" || event === "transfer_received") {
    const amount = payload?.amount ?? payload?.amountUsdc ?? "?";
    const chain = (payload?.chain || "unknown").toUpperCase();
    const fromName = payload?.from_name || payload?.fromName;
    const fromDid = payload?.from_did || payload?.fromDid || payload?.senderDid || payload?.from || "";
    const fromLabel = fromName || (fromDid ? `…${fromDid.slice(-12)}` : "某地址");
    // Currency comes from the payload — platform's transfer events cover
    // USDC (Base/BSC/Fast), ATEL internal token, and may extend later.
    // 2026-05-12 tester report: previously hardcoded "USDC" displayed
    // "10 USDC" for a 10 ATEL_INTERNAL token transfer, misleading the
    // recipient even though balances were correct. amountUsdc field
    // implies USDC, otherwise trust currency/asset from payload.
    const currency = String(
      payload?.currency ||
      payload?.asset ||
      (payload?.amountUsdc != null ? "USDC" : "?")
    ).toUpperCase();
    // Show full tx hash on its own line — truncating the tail loses the
    // ability to copy it into a block explorer. Long is fine in TG.
    const tx = payload?.tx_hash || payload?.txHash;
    const txLine = tx ? `\ntx: ${tx}` : "";
    return `💰 收到转账 ${amount} ${currency}（${chain} 链）\n\n来自: ${fromLabel}${txLine}`;
  }

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
      // 3500 chars matches atel-tg-bot relay-poller fix (commit 17d0a4f) —
      // 250 was too short to show real deliverables (code review, docs, etc).
      // TG message limit is 4096; reserve ~500 for header/order line/ellipsis.
      const body = previewContent(payload?.resultSummary || payload?.deliverable || payload?.content, 3500);
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

    case "task_start":
      // Only executor receives — platform's "OK to start working" signal.
      // Most useful when the executor missed the order_accepted card.
      if (role === "executor" || role === null) {
        return `${tag} 🚦 任务已启动\n\n订单: ${orderId}\n可以开始干活了。`;
      }
      return null;

    case "escrow_confirmed":
      // Platform sends only to executor when requester's escrow lands —
      // signal that funds are locked and it's safe to start work.
      return `${tag} 🔒 对方资金已锁仓\n\n订单: ${orderId}\n可以开始干活，结算时自动放款。`;

    case "order_cancelled": {
      const reason = previewContent(payload?.reason, 200) || "未知原因";
      const refund = payload?.refund_amount ?? payload?.refundAmount;
      const refundExp = payload?.refund_expected ?? payload?.refundExpected;
      if (role === "requester") {
        const refundLine = refund != null ? `\n退款: ${refund} USDC（已退回钱包）` : "";
        return `${tag} 🛑 订单已取消\n\n订单: ${orderId}\n原因: ${reason}${refundLine}`;
      }
      if (role === "executor") {
        const expLine = refundExp ? `\n${refundExp}` : "";
        return `${tag} 🛑 订单已取消\n\n订单: ${orderId}\n原因: ${reason}${expLine}`;
      }
      return `${tag} 🛑 订单已取消\n\n订单: ${orderId}\n原因: ${reason}`;
    }

    case "order_expired": {
      const reason = previewContent(payload?.reason, 200) || "超时未处理";
      if (role === "requester") {
        return `${tag} ⏰ 订单已超时取消\n\n订单: ${orderId}\n${reason}\n资金已退回钱包。`;
      }
      return `${tag} ⏰ 订单已超时取消\n\n订单: ${orderId}\n${reason}`;
    }

    case "dispute_created": {
      const disputeId = payload?.disputeId || payload?.dispute_id || "?";
      const reason = previewContent(payload?.reason, 200) || "未知原因";
      return `${tag} ⚖️ 争议已创建\n\n订单: ${orderId}\n争议号: ${disputeId}\n原因: ${reason}\n等待仲裁结果。`;
    }
    case "dispute_resolved": {
      const disputeId = payload?.disputeId || payload?.dispute_id || "?";
      const resolution = payload?.resolution || "未知";
      const resolutionLabel = ({
        auto_refund: "自动退款给买家",
        refund_requester: "退款给买家",
        pay_executor: "放款给执行方",
        split: "双方分账",
      })[resolution] || resolution;
      return `${tag} ⚖️ 争议已结案\n\n订单: ${orderId}\n争议号: ${disputeId}\n结果: ${resolutionLabel}`;
    }

    case "milestone_arbitration_passed": {
      const idx = payload?.milestoneIndex ?? payload?.index ?? "?";
      if (role === "executor") {
        return `${tag} ⚖️ 仲裁裁定里程碑 #${idx} 通过\n\n订单: ${orderId}\n资金已放款。`;
      }
      return `${tag} ⚖️ 仲裁裁定里程碑 #${idx} 通过\n\n订单: ${orderId}\n资金已转给执行方。`;
    }
    case "milestone_arbitration_failed": {
      const idx = payload?.milestoneIndex ?? payload?.index ?? "?";
      const reason = previewContent(payload?.reason, 200) || "仲裁未通过";
      if (role === "executor") {
        return `${tag} ⚖️ 仲裁裁定里程碑 #${idx} 不通过\n\n订单: ${orderId}\n${reason}\n订单将被取消。`;
      }
      return `${tag} ⚖️ 仲裁裁定里程碑 #${idx} 不通过\n\n订单: ${orderId}\n${reason}\n资金将退回。`;
    }

    // ─── A2B (Bitrefill 礼品卡) 全流程事件 ──────────────────────────────
    // Each step is a real platform-side milestone the user should see, so
    // they know the order is progressing and (for delivery_confirmed) so
    // they receive the redemption code in a copy-friendly format without
    // the agent LLM rewriting it.
    case "a2b_order_created": {
      const product = payload?.productName || payload?.product?.name || payload?.productId || "?";
      const value = payload?.value ?? "?";
      const currency = payload?.currency || "";
      return `🎁 礼品卡订单已建立\n\n${product} ${value} ${currency}\n准备充值 / 付款...`;
    }
    case "a2b_quote_previewed": {
      const product = payload?.productName || payload?.product?.name || payload?.productId || "?";
      const value = payload?.value ?? "?";
      const currency = payload?.currency || "";
      const usdc = payload?.quotedPriceUsdc ?? payload?.priceUsdc;
      return `🎁 报价: ${product} ${value} ${currency}\n约 ${usdc ?? "?"} USDC\n\n说"确认买"或"取消"。`;
    }
    case "a2b_deposit_confirmed":
      return `🪙 充值已到账\n\n继续准备发票...`;
    case "a2b_invoice_created": {
      const invoiceId = payload?.invoiceId || payload?.bitrefillInvoiceId;
      const amount = payload?.paymentAmount ?? payload?.quotedPriceUsdc ?? "?";
      return `📄 Bitrefill 发票已生成\n\n金额: ${amount} USDC\n${invoiceId ? `invoice: ${invoiceId}` : ""}\n准备链上付款...`;
    }
    case "a2b_payment_executed": {
      const tx = payload?.tx_hash || payload?.txHash || payload?.tx;
      const txLine = tx ? `\ntx: ${tx}` : "";
      return `💳 付款已上链${txLine}\n\n等 Bitrefill 出礼品卡（通常几秒到一分钟）...`;
    }
    case "a2b_delivery_pending":
      return `⏳ 等 Bitrefill 准备礼品卡\n\n稍等，平台正在自动重试取货。`;
    case "a2b_delivery_confirmed":
    case "a2b_delivery_completed": {
      const code = payload?.code || payload?.redemptionCode;
      const pin = payload?.pin;
      const link = payload?.link || payload?.redemptionUrl;
      const product = payload?.productName || payload?.product?.name || payload?.productId || "礼品卡";
      const expiresAt = payload?.expiresAt || payload?.expirationDate;
      const lines = [`🎉 ${product} 已交付！`, ""];
      if (code) lines.push(`兑换码: ${code}`);
      if (pin) lines.push(`PIN: ${pin}`);
      if (link) lines.push(`链接: ${link}`);
      if (expiresAt) lines.push(`过期: ${expiresAt}`);
      if (payload?.instructions) lines.push(`\n${payload.instructions}`);
      return lines.join("\n");
    }
    case "a2b_delivery_failed": {
      const reason = payload?.reason || "未知原因";
      const hint = payload?.hint || "可联系支持或稍后用 atel_a2b_redemption 手动重试";
      return `⚠️ 礼品卡交付失败\n\n原因: ${reason}\n${hint}`;
    }
    // Webhook-side state transitions — emitted by platform when the
    // Bitrefill webhook (or the polling fallback) confirms a state change
    // that doesn't fit any of the Bitrefill-side milestone events above.
    // a2b_payment_confirmed: invoice transitioned to "paid" (Bitrefill
    //   has seen our USDC tx land); useful when the payment_executed card
    //   was emitted optimistically before chain confirmation.
    // a2b_invoice_failed: invoice expired / failed before delivery; we
    //   surface so the user knows the funds will be refunded and they
    //   shouldn't re-trigger.
    case "a2b_payment_confirmed": {
      const inv = payload?.invoiceId || payload?.bitrefillInvoiceId || "";
      return `✅ Bitrefill 已确认收到付款${inv ? `\ninvoice: ${inv}` : ""}\n\n等出卡。`;
    }
    case "a2b_invoice_failed": {
      const status = payload?.status || "失败";
      const inv = payload?.invoiceId || payload?.bitrefillInvoiceId || "";
      return `⚠️ 礼品卡发票 ${status}${inv ? `\ninvoice: ${inv}` : ""}\n\n如已扣款将自动退回，不要重复下单。`;
    }

    default:
      return null;
  }
}

// Custom error class so dispatchEvent can tell permanent (drop chat)
// from transient (worth retrying / waiting for next event).
class TgSendError extends Error {
  constructor(message, { status = 0, permanent = false } = {}) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

// 2026-05-13 fix: retry transient failures. Pre-fix, life7days_bot lost a
// milestone_verified card to a single `fetch failed` (likely TLS reset)
// and the user never saw M1 progress — the platform doesn't replay
// listener-delivered events, so a one-shot failure here means permanent
// loss to the user. Now: 3 attempts with backoff 500ms / 2s / 8s.
//
// Failure modes mapped to actions:
//   - fetch threw (network/DNS/TLS) → retry
//   - TG 5xx / 429 (server overload, rate limit) → retry
//   - TG 4xx other (400 bad request, 401 invalid token) → no retry, throw
//   - TG 403 Forbidden ("bot blocked by user", "kicked from group") →
//     permanent, throw with permanent=true so caller adds to blockedChats
async function sendTg(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const backoffs = [500, 2000, 8000]; // ms between attempts; last entry ignored after the final try

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch (e) {
      // Transient — fetch itself failed (DNS / TLS / connection reset).
      // Retry.
      lastErr = new TgSendError(`fetch failed: ${e && e.message || e}`, { status: 0 });
      if (attempt < 2) await sleep(backoffs[attempt]);
      continue;
    }
    if (res.ok) return; // 2xx
    const body = await res.text().catch(() => "");
    const snippet = body.slice(0, 200);
    if (res.status === 403) {
      // Permanent: bot blocked / kicked / chat deleted. No point retrying.
      throw new TgSendError(`tg ${res.status}: ${snippet}`, { status: res.status, permanent: true });
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      // Other 4xx (400 bad request, 401 unauthorized, 404 chat not found).
      // 404 (chat not found) is also a permanent-ish failure for *this*
      // chat. Treat them all as permanent.
      throw new TgSendError(`tg ${res.status}: ${snippet}`, {
        status: res.status,
        permanent: res.status === 400 || res.status === 401 || res.status === 404,
      });
    }
    // 5xx or 429 → retry
    lastErr = new TgSendError(`tg ${res.status}: ${snippet}`, { status: res.status });
    if (attempt < 2) await sleep(backoffs[attempt]);
  }
  throw lastErr || new TgSendError("tg send failed after 3 attempts", { status: 0 });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  //
  // Important: platform sometimes ships a degenerate dedupeKey like
  // ":transfer_received" (empty orderId prefix because transfer events
  // have no order). That collapses every consecutive transfer into one
  // card per 5 minutes — wrong; user wants a card per transfer. Detect
  // that shape and fall back to a per-event unique key built from the
  // tx hash / event id.
  let dedupe = messageBody?.dedupeKey || `${eventType}:${payload?.orderId}:${payload?.milestoneIndex ?? ""}`;
  if (dedupe.startsWith(":") || dedupe === "") {
    const txKey = payload?.tx_hash || payload?.txHash || messageBody?.eventId || messageBody?.body?.eventId || String(Date.now());
    dedupe = `${eventType}:${txKey}`;
  }
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
  const chatIdRaw = readChatIdFromSideChannel(path.resolve(extensionDir, ".."));
  if (!token || !chatIdRaw) {
    console.warn(`[atel-mcp/tg-dispatch] missing ${!token ? "bot token" : ""} ${!chatIdRaw ? "chat id" : ""}; skipping card for ${eventType}`);
    return;
  }
  const chatIds = String(chatIdRaw).split(",").map(s => s.trim()).filter(Boolean);
  // 2026-05-13 fix: skip chats we've already marked as permanently
  // dead (403 / 400 / 404). Don't spam TG API or log lines.
  const liveChats = chatIds.filter((c) => !blockedChats.has(c));
  const skipped = chatIds.length - liveChats.length;
  if (skipped > 0 && liveChats.length === 0) {
    // Every cached chat is dead — force a re-resolve next tick by
    // invalidating the cache early. A re-paired user (block→unblock,
    // or a new bot DM) will then get cards once they show up in
    // sessions.json / atel-state.json.
    cachedChatEntry = null;
    console.warn(`[atel-mcp/tg-dispatch] all ${chatIds.length} chat(s) are blocked; invalidating chat cache and skipping ${eventType}`);
    return;
  }
  for (const chatId of liveChats) {
    try {
      await sendTg(token, chatId, card);
      console.log(`[atel-mcp/tg-dispatch] sent event=${eventType} order=${payload?.orderId || "?"} chat=${chatId} chars=${card.length}`);
    } catch (e) {
      if (e && e.permanent) {
        blockedChats.add(chatId);
        console.warn(`[atel-mcp/tg-dispatch] PERMANENTLY skipping chat=${chatId} after ${e.message}; will not retry until listener restart or chat re-pair`);
      } else {
        console.warn(`[atel-mcp/tg-dispatch] send failed event=${eventType} chat=${chatId}: ${e && e.message} (event dropped after 3 retries)`);
      }
    }
  }
}
