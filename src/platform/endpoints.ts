export const PLATFORM_ENDPOINTS = {
  auth: {
    challenge: '/auth/v1/challenge',
    verify: '/auth/v1/verify',
    session: '/auth/v1/session',
    me: '/auth/v1/me'
  },
  registry: {
    register: '/registry/v1/register',
    remoteRegister: '/registry/v1/remote/register',
    search: '/registry/v1/search',
    agent: (did: string) => `/registry/v1/agent/${encodeURIComponent(did)}`
  },
  account: {
    balance: '/account/v1/balance',
    depositInfo: '/account/v1/deposit-info'
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
    detail: (disputeId: string) => `/dispute/v1/${encodeURIComponent(disputeId)}`
  },
  a2b: {
    search: '/trade/v1/a2b/bitrefill/search',
    intent: '/trade/v1/a2b/intent',
    deposit: '/trade/v1/a2b/wallet/deposit',
    createInvoice: '/trade/v1/a2b/bitrefill/createInvoice',
    pay: '/trade/v1/a2b/wallet/pay',
    redemption: '/trade/v1/a2b/bitrefill/redemption',
    list: '/trade/v1/a2b/list',
    detail: (intentId: string) => `/trade/v1/a2b/detail/${encodeURIComponent(intentId)}`,
    redemptionReveal: (intentId: string) => `/trade/v1/a2b/redemption-reveal/${encodeURIComponent(intentId)}`
  }
} as const;
