export const PLATFORM_ENDPOINTS = {
  auth: {
    challenge: '/auth/v1/challenge',
    verify: '/auth/v1/verify',
    session: '/auth/v1/session',
    me: '/auth/v1/me',
    register: '/auth/v1/register', // T3.1.1 — mints fresh identity (no auth required)
    recovery: '/auth/v1/recovery'  // T3.1.5 — look up DID by recovery code (no auth required)
  },
  registry: {
    register: '/registry/v1/register',
    remoteRegister: '/registry/v1/remote/register',
    remoteEndpoint: '/registry/v1/remote/endpoint', // T3.1.3 — advertise callback URL with reachability check
    search: '/registry/v1/search',
    agent: (did: string) => `/registry/v1/agent/${encodeURIComponent(did)}`
  },
  account: {
    balance: '/account/v1/balance',
    depositInfo: '/account/v1/deposit-info'
  },
  wallet: {
    // JWT-authenticated platform withdraw endpoint. Fast / EVM both route
    // here; chain='fast' takes a 64-char hex recipient, EVM takes 0x..40
    // hex. The /trade/v1/wallet/withdraw twin is DID-Sig only (used by
    // SDK / 龙虾 runtime that holds the user's secretKey directly).
    // MCP can't DID-Sig-sign because it doesn't see the secretKey, so
    // it uses the -jwt alias which is bearer-authenticated.
    // (Bug found 2026-05-03 during scenario 3 — Fast transfer was
    // hitting the DID-Sig path with a JWT and returning 401.)
    withdraw: '/trade/v1/wallet/withdraw-jwt'
  },
  contacts: {
    list: '/contacts/v1/list'
  },
  relay: {
    send: '/relay/v1/send',
    poll: '/relay/v1/poll',
    inbox: '/relay/v1/inbox',
    ack: '/relay/v1/ack'
  },
  trade: {
    order: '/trade/v1/order',
    remoteOrder: '/trade/v1/remote/order',
    orders: '/trade/v1/orders',
    milestones: (orderId: string) => `/trade/v1/order/${encodeURIComponent(orderId)}/milestones`,
    timeline: (orderId: string) => `/trade/v1/order/${encodeURIComponent(orderId)}/timeline`,
    accept: (orderId: string) => `/trade/v1/order/${encodeURIComponent(orderId)}/accept`,
    remoteAccept: (orderId: string) => `/trade/v1/remote/order/${encodeURIComponent(orderId)}/accept`,
    remoteComplete: (orderId: string) => `/trade/v1/remote/order/${encodeURIComponent(orderId)}/complete`,
    remoteConfirm: (orderId: string) => `/trade/v1/remote/order/${encodeURIComponent(orderId)}/confirm`,
    milestoneSubmit: (orderId: string, index: number) => `/trade/v1/order/${encodeURIComponent(orderId)}/milestone/${index}/submit`,
    remoteMilestoneSubmit: (orderId: string, index: number) => `/trade/v1/remote/order/${encodeURIComponent(orderId)}/milestone/${index}/submit`,
    milestoneVerify: (orderId: string, index: number) => `/trade/v1/order/${encodeURIComponent(orderId)}/milestone/${index}/verify`,
    remoteMilestoneVerify: (orderId: string, index: number) => `/trade/v1/remote/order/${encodeURIComponent(orderId)}/milestone/${index}/verify`
  },
  dispute: {
    list: '/dispute/v1/list',
    create: '/dispute/v1/open',
    remoteCreate: '/dispute/v1/remote/open',
    detail: (disputeId: string) => `/dispute/v1/${encodeURIComponent(disputeId)}`,
    // T3.6.2 — arbitrator action via MCP. Mounted under /remote/ (JWT
    // auth path). Platform default fail-closed; requires caller DID in
    // ATEL_ARBITRATOR_DIDS env. Returns 501 in v0.2 — splitRatio →
    // absolute-amount conversion is fenced for ops review.
    resolve: (disputeId: string) => `/dispute/v1/remote/${encodeURIComponent(disputeId)}/resolve`
  },
  a2b: {
    // KNOWN GAP (audit-found 2026-05-03): these paths are DID-Sig
    // protected on platform; the MCP server holds a JWT not a DID
    // signature, so calling them returns 401 "invalid timestamp".
    //
    // Platform exposes a JWT mount at /trade/v1/remote/a2b/* via
    // RegisterRemoteWriteRoutes covering: product-search, quote-preview,
    // order (= intent), order/:id/pay, order/:id/redemption, order/:id (GET).
    // It DOES NOT yet expose JWT versions of: wallet/deposit (lock_funds
    // backing call) and bitrefill/createInvoice (execute_purchase
    // backing call). Until platform adds those:
    //   - search/intent/pay/list/detail need MCP-adapter path migration
    //     to /trade/v1/remote/a2b/*
    //   - lock_funds + execute_purchase remain BLOCKED via MCP path
    //
    // Below paths are kept as-is for reference; full A2B-via-MCP is
    // tracked as a follow-up after platform adds 2 missing JWT handlers.
    search: '/trade/v1/a2b/bitrefill/search',
    intent: '/trade/v1/a2b/intent',
    deposit: '/trade/v1/a2b/wallet/deposit',
    createInvoice: '/trade/v1/a2b/bitrefill/createInvoice',
    pay: '/trade/v1/a2b/wallet/pay',
    redemption: '/trade/v1/a2b/bitrefill/redemption',
    list: '/trade/v1/a2b/list',
    detail: (intentId: string) => `/trade/v1/a2b/detail/${encodeURIComponent(intentId)}`,
    redemptionReveal: (intentId: string) => `/trade/v1/a2b/redemption-reveal/${encodeURIComponent(intentId)}`,
    // T3.4.1 — server-side amount calculation. This one DOES use the
    // /remote/ JWT path because it was added recently (T3.4.1) targeted
    // at MCP from day one.
    quote: '/trade/v1/remote/a2b/quote-preview'
  }
} as const;
