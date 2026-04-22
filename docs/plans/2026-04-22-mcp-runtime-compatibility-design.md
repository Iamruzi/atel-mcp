# ATEL MCP / Runtime Compatibility Design

**Date:** 2026-04-22

**Goal:** Make MCP the default user entry while keeping the current SDK path compatible by repositioning SDK as the execution runtime, not the mandatory user-facing product.

## 1. Product target

ATEL should support three user modes without splitting business truth:

1. `MCP-only`
   Normal users connect ATEL through Claude Code, Codex, OpenClaw-hosted MCP, or other Remote MCP hosts.
   They do not install SDK, do not open ports, and do not manage relay/gateway details.

2. `Runtime-only`
   Advanced users continue to self-host the current SDK/CLI/native flow.
   This stays supported for OpenClaw-native operators and self-hosted agent users.

3. `MCP + Runtime`
   Linked power-user mode.
   The user controls ATEL from MCP, but execution is delegated to a linked runtime when local tools, files, or autonomous callbacks are needed.

The key constraint: these are different entry modes, not different business systems.

## 2. Non-negotiable invariants

The following must remain platform-owned:

- order state machine
- milestone state machine
- dispute/arbitration state machine
- audit and timeline truth
- settlement and refund truth
- source metadata (`sourceType`, `sourceLabel`, actor identity)

Neither MCP nor runtime may invent workflow transitions.
They may only call platform actions or consume platform callbacks.

## 3. Role split

### Platform

Platform is the single source of truth.
It owns:

- identity/session truth for hosted users
- linked identity mapping for runtime users
- messaging persistence and relay envelopes
- order/milestone/dispute progression
- audit/query surfaces
- arbitration outcomes
- settlement outcomes

### MCP

MCP becomes the primary control plane for normal users.
It owns:

- OAuth/bearer auth boundary
- scope enforcement
- stable tool schemas
- host-facing structured input/output
- source tagging for MCP-originated actions
- optional routing to hosted or linked runtime backends

MCP should not own local execution semantics.

### Runtime (current SDK)

SDK is repositioned as Runtime.
It owns:

- local DID/native execution where needed
- OpenClaw-native runtime behavior
- local callback handling and autonomous progression hooks
- file/tool execution for self-hosted agents
- local notification fan-out

Runtime remains optional for normal MCP users.

## 4. Migration strategy

### Phase A: Compatibility framing

Do now.

- Keep existing SDK flows working
- Keep existing MCP flows working
- Make public documentation explicit: MCP is the main user entry, SDK is runtime
- Publish machine-readable service metadata from MCP describing supported user modes and runtime backends
- Remove platform defaults that cause source-label drift across MCP vs non-MCP traffic

### Phase B: Shared contracts

Next.

Create a shared domain contract layer for:

- identity/session model
- message envelope model
- order write/read model
- milestone write/read model
- dispute model
- audit query model
- source metadata model

MCP, Platform, and Runtime must consume the same contracts.

### Phase C: Linked-runtime mode

After contracts stabilize.

Introduce explicit MCP execution routing:

- `hosted`: platform-hosted actions only
- `linked-runtime`: hand off runtime-capable actions to a linked runtime identity
- `hybrid`: platform first, runtime when capability requires it

This phase needs linked identity records and runtime registration metadata.

### Phase D: MCP-first productization

- New users onboard through MCP by default
- Runtime becomes optional advanced/self-hosted path
- OpenClaw-native operators can still use runtime directly
- Hosted users never need to install SDK

## 5. Identity model

Long-term identity modes:

- `hosted`
  DID/session is platform-hosted and fully usable through MCP.

- `linked-runtime`
  Platform account is linked to one or more runtime DIDs.
  MCP can route work to the linked runtime.

- `self-hosted-runtime`
  User bypasses hosted MCP and operates runtime directly.

The platform must understand that these are different access modes for the same user or tenant, not unrelated actors.

## 6. First implementation seam

The safest immediate seam is not state-machine refactor.
It is service framing and metadata:

- ATEL MCP should declare itself `mcp-primary`
- SDK should declare itself `runtime`
- MCP metadata should expose supported user modes and runtime backends
- Docs should tell users that SDK is optional unless they need self-hosted execution

This is safe because it does not change order, milestone, relay, or dispute mechanics.

## 7. Risks

1. If MCP and Runtime both gain their own business rules, they will drift.
2. If identity linking is skipped, users will appear as different people across MCP and Runtime.
3. If source metadata is not explicit, callbacks will continue to mislabel MCP vs non-MCP traffic.
4. If hosted users still depend on local runtime assumptions, MCP-only onboarding will never feel complete.

## 8. Immediate execution items

1. Add MCP service metadata that advertises:
   - user entry mode
   - runtime role
   - runtime backend strategy
   - supported user modes
2. Update SDK README so SDK is described as optional Runtime for hosted users.
3. Update MCP quick-start docs so normal users understand they do not need SDK.
4. Keep existing OpenClaw-native wording but reposition it as runtime/native mode, not the only serious path.
5. Later: implement linked-runtime routing and identity linking on top of the same contracts.
