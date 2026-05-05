export const PLATFORM_ENDPOINTS = {
  auth: {
    challenge: '/auth/v1/challenge',
    verify: '/auth/v1/verify',
    session: '/auth/v1/session',
    me: '/auth/v1/me',
    register: '/auth/v1/register', // T3.1.1 — mints fresh identity (no auth required)
    recovery: '/auth/v1/recovery',  // T3.1.5 — look up DID by recovery code (no auth required)
    secretKeyRecover: '/auth/v1/secret-key-recover' // T3.1.5+ — recover full secretKey via recoveryCode (KEK-encrypted backup, no auth)
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
    // Platform exposes /relay/v1/send (DID-Sig) and /relay/v1/send-jwt
    // (JWT bearer). MCP holds a JWT, so use the -jwt alias. The DID-Sig
    // twin would 401 with "invalid timestamp" on every send.
    // (Same pattern as /trade/v1/wallet/withdraw-jwt — discovered
    // 2026-05-03 during real-runtime e2e on 龙虾1 sending a message.)
    send: '/relay/v1/send-jwt',
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
    remoteMilestoneVerify: (orderId: string, index: number) => `/trade/v1/remote/order/${encodeURIComponent(orderId)}/milestone/${index}/verify`,
    // Plan-confirmation gate. After atel_order_accept locks escrow, the
    // order sits in milestone_review. Both requester AND executor must
    // POST {approved:true} here before M0 starts. Either side can also
    // POST {approved:false, feedback:"..."} to request revisions.
    remoteMilestonesFeedback: (orderId: string) => `/trade/v1/remote/order/${encodeURIComponent(orderId)}/milestones/feedback`
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
    // All A2B routes use the JWT-authenticated /trade/v1/remote/a2b/*
    // mount (RegisterRemoteWriteRoutes). The legacy /trade/v1/a2b/*
    // endpoints are DID-Sig only and 401 against an MCP-server JWT.
    //
    // Platform's remote A2B is more consolidated than the legacy
    // stepwise DID-Sig flow: the `/trade/v1/remote/a2b/order` endpoint
    // runs the full quote → intent → deposit → invoice → pay →
    // (optional) redemption pipeline in one call. The legacy multi-step
    // MCP tools (intent_create / lock_funds / execute_purchase) all
    // funnel through this single platform call now.
    search: '/trade/v1/remote/a2b/product-search',
    quote: '/trade/v1/remote/a2b/quote-preview',
    purchase: '/trade/v1/remote/a2b/order',
    pay: (intentId: string) => `/trade/v1/remote/a2b/order/${encodeURIComponent(intentId)}/pay`,
    redemption: (intentId: string) => `/trade/v1/remote/a2b/order/${encodeURIComponent(intentId)}/redemption`,
    list: '/trade/v1/remote/a2b/orders',
    detail: (intentId: string) => `/trade/v1/remote/a2b/order/${encodeURIComponent(intentId)}`,
    redemptionReveal: (intentId: string) => `/trade/v1/remote/a2b/order/${encodeURIComponent(intentId)}/redemption`,
    // Legacy multi-step MCP tools — same backing call, different
    // semantics in the adapter (see a2bIntent / a2bDeposit /
    // a2bCreateInvoice in adapters.ts).
    intent: '/trade/v1/remote/a2b/order',
    deposit: '/trade/v1/remote/a2b/order',
    createInvoice: '/trade/v1/remote/a2b/order'
  }
} as const;
