# Platform Binary Rollback Runbook

Tier 7.4 deliverable — drill-tested 2026-05-05 on testnet 144.202.53.72.

## When to use

Roll back if a freshly deployed `atel-platform` binary:
- Fails to start (pm2 error log shows panic / missing env / DB migration error)
- Breaks one of the smoke endpoints (`/account/v1/balance`, `/registry/v1/remote/endpoint`, `/relay/v1/multiPoll`)
- Triggers an alert spike that you can't immediately diagnose
- Was never green for your full smoke list

Rolling back is faster than diagnosing in-flight. Restore service first, then debug from logs.

## Pre-deploy invariant

Every deploy MUST leave a single `.bak.<date>-<reason>` next to the live binary:

```
/opt/atel-platform/atel-platform                       # currently running
/opt/atel-platform/atel-platform.bak.20260505-mcp-v021-https  # previous good
/opt/atel-platform/atel-platform-mcp-v021.keep         # candidate (the new one we just deployed)
```

Without these three files in place, rollback turns into "rebuild from git", which can take 10+ minutes and may not match what was previously running.

## Rollback (≤ 60 seconds)

SSH into the box and run:

```bash
ssh root@<HOST>
cd /opt/atel-platform

# 1. Halt current process so the file is no longer "text busy"
pm2 stop atel-platform
sleep 2

# 2. Save current binary as the "candidate.keep" so we can roll forward
#    later if the rollback turns out to be unnecessary
cp atel-platform atel-platform.candidate-failed.$(date +%Y%m%d-%H%M%S)

# 3. Swap in the previous good binary
cp atel-platform.bak.<date>-<reason> atel-platform
chmod +x atel-platform

# 4. Restart with shell-sourced env (pm2 env_file is unreliable — see
#    feedback_pm2_env_file_broken)
set -a; source .env; set +a
pm2 start ecosystem.config.cjs --update-env

# 5. Smoke
sleep 4
pm2 list | grep atel-platform   # status=online, uptime resetting from 0
curl -fsS http://localhost:8200/account/v1/balance \
  -H "Authorization: Bearer <known-good-jwt>" | head -c 200
```

## Roll forward (when rollback was a false alarm)

```bash
cd /opt/atel-platform
pm2 stop atel-platform
sleep 2
cp atel-platform-mcp-v021.keep atel-platform   # the candidate we set aside
chmod +x atel-platform
set -a; source .env; set +a
pm2 start ecosystem.config.cjs --update-env
```

## Drill record

| Date       | Operator | From version       | To version         | Outcome | Time |
|------------|----------|--------------------|--------------------|---------|------|
| 2026-05-05 | Mark Ma  | mcp-v021 (env-tier)| pre-mcp-v021-https | OK      | 15s  |
| 2026-05-05 | Mark Ma  | pre-mcp-v021-https | mcp-v021 (env-tier)| OK      | 15s  |

Verification: rolling back to pre-mcp-v021-https correctly rejects `http://`
URLs on POST /registry/v1/remote/endpoint (the env-tier behavior is gone).
Rolling forward restores acceptance.

## Gotchas

- **"Text file busy" on `cp atel-platform`** → you forgot to `pm2 stop`
  first. Linux refuses to overwrite a running ELF.
- **DB migration drift** → if the new binary added a migration and you roll
  back, the schema is ahead of the rolled-back binary. Most migrations are
  forward-compatible (additive) but if you see startup errors check
  `psql atel_test -c "\\d <table>"` for unexpected columns. Down-migrate
  manually if needed.
- **pm2 env_file unreliable on testnet** → always `set -a; source .env;
  set +a` before `pm2 start ... --update-env`, or DB credentials won't
  reach the process.
- **Backup naming** → never `atel-platform.bak` (no date). Multiple
  rollbacks will overwrite each other and you lose your safety net.
