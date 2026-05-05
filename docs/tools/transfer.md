# atel_wallet_transfer / atel_fast_transfer / atel_wallet_withdraw

Why these tools all require `chain` to be passed explicitly, and how the
LLM should pick it.

## Why chain is mandatory

ATEL identities have **three independent USDC balances** under the same
DID:

| Chain | Settlement | Address format        | What lives here |
|-------|-----------|------------------------|-----------------|
| `base` | Base L2 (EVM) | `0x...` 42 chars     | Order escrow, anchor records, A2B (Bitrefill) |
| `bsc` | BSC (EVM)     | `0x...` 42 chars     | Cross-chain payments, payment-gateway deposits |
| `fast` | Fast Network | `fast1...` bech32m / 64-char hex | TG-to-TG instant transfers, ed25519-signed |

These are NOT bridged automatically. 1 USDC on base is **not** the same
as 1 USDC on fast. Sending without specifying chain would force the tool
to either:

1. Pick a default (silently — bug-prone, the LLM would never know which)
2. Fall back to "first chain with sufficient balance" (silently routes
   user's $10 base purchase from their fast balance)
3. Try all three (3× chain ops, 2 of them likely failing)

None of those are safe. **Mandatory chain = the LLM must reason about
which one explicitly.**

## How to pick chain (LLM rules)

**Rule 1: If the user says it, use it.**
> "transfer 5 USDC on base to alice" → `chain="base"`
> "send 1 USDC over fast to bob" → `chain="fast"`

**Rule 2: If recipient address starts with `fast1` (bech32m) or is a 64-char
hex, use `fast`.**
The recipient's address format pins the chain. Sending a Fast address
through the base chain will fail with an unrecognized-recipient error,
not silently re-route.

**Rule 3: If recipient is a DID, ATEL identities have all three. Ask.**
A DID maps to base/bsc/fast addresses simultaneously. The user has to
pick. Don't default — ask:

> "Which chain should I send this on? Your balances:
> - base: 5.20 USDC
> - bsc: 0.00 USDC
> - fast: 1.45 USDC"

**Rule 4: If the user says a recipient name (e.g. "send to alice"), look
them up via `atel_agent_search` first; the result includes their wallet
addresses per chain. Pick whichever they have a balance to receive on,
or ask the user.**

**Rule 5: Cross-chain swaps are NOT a transfer.** If the user asks "send
my fast balance to base", that's not a `chain="base"` transfer — it's a
swap (currently unimplemented; tell the user).

## Common LLM mistakes

| Mistake | Why it's wrong | Fix |
|---|---|---|
| Defaulting to `chain="base"` because Base is "primary" | User might have 0 USDC on base and 10 on fast | Check `atel_balance` first |
| Sending to a `fast1...` address with `chain="base"` | Chain mismatch will fail — but the failure isn't always loud | Address format → chain |
| Using `chain="fast"` for an A2B Bitrefill purchase | Bitrefill only takes base USDC | A2B is always base — don't ask |
| Sending across chains as one operation | These are independent ledgers | Two transfers + a swap |

## How `atel_balance` helps

`atel_balance` returns the per-chain breakdown:

```json
{
  "balances": {
    "base": "5.200000",
    "bsc": "0.000000",
    "fast": "1.450000"
  },
  "addresses": {
    "base": "0xa402...4c6",
    "bsc": "0x64b9...078",
    "fast": "fast14jcw...x553q"
  }
}
```

Pattern:

```
1. atel_balance — see what's available where
2. Decide chain (rules above)
3. atel_wallet_transfer (or atel_fast_transfer for fast-specific UX)
```

## Withdraw is the same rule

`atel_wallet_withdraw` requires `chain` for the same reason. A withdrawal
to an external 0x address could be base or bsc — those are different
networks even though the address format is the same. Picking wrong sends
USDC to the void (well, to the same address on the wrong chain — could
recover with the private key, but the user shouldn't have to).

## Future: chain auto-pick

Long-term we want to lift this constraint by making `chain` optional with
a deterministic auto-pick:

1. If recipient address format pins chain → use it
2. Else if user has only one chain with sufficient balance → use it
3. Else error with the multi-chain hint above

Documented but not implemented (T3.5.4). Until then, **always pass
`chain`** — it's safer to ask the user once than to silently move funds
on the wrong ledger.
