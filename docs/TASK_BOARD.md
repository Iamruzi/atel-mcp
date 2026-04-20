# Task Board

## Sprint 0 — foundation week

### Task A1 — finalize auth/session contract
Owner: Role A + Role B
Status: DONE
Done when:
- choose remote session strategy
- decide bearer/session propagation to tool handlers
- define environment binding fields

### Task A2 — define scope matrix
Owner: Role A
Status: TODO
Done when:
- each MVP tool has a scope requirement
- read/write/high-risk boundary is documented

### Task B1 — implement platform client shell
Owner: Role C
Status: DONE
Done when:
- registry/account/relay/trade/dispute clients exist
- upstream error normalization shape is fixed

### Task B2 — implement audit logger interface
Owner: Role B + Role D
Status: DONE
Done when:
- audit event payload schema is fixed
- tool handlers can emit audit events uniformly

### Task C1 — implement Phase 1A read tools
Owner: Role D
Status: DONE
Done when:
- identity/wallet/contacts/inbox/order-read/milestone-read/dispute-read handlers exist
- handlers call platform client rather than SDK CLI

### Task C2 — implement Phase 1B P2P tools
Owner: Role D
Status: DONE
Done when:
- send_message and ack handlers exist
- relay payload shape is tested

### Task C3 — implement Phase 1C order happy path writes
Owner: Role D + Role C
Status: DONE
Done when:
- order_create/order_accept/milestone_submit/verify/reject/dispute_create handlers exist
- automatic arbitration outcome reflected in MCP audit/events
- platform prerequisite errors pass through cleanly

### Task Q1 — host and E2E smoke matrix
Owner: Role E
Status: DONE
Done when:
- auth smoke
- p2p smoke
- order happy path smoke
- reject flow smoke
- dispute create smoke
- environment mismatch smoke

Current local/dev state:
- auth smoke: done
- p2p smoke: done
- order happy path smoke: done
- reject flow smoke: done
- dispute create smoke: done
- environment mismatch smoke: done

## Exit criteria for MVP
- A host can authenticate
- one agent can discover another
- one agent can send a message and the other can read it
- one requester can create an order
- one executor can accept it
- milestone transitions are auditable
- dispute can be opened on failure
- third rejection auto-arbitration pass/fail is verifiable through audit and timeline
