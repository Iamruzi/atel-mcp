# Claude / AI Working Rules — atel-mcp

**Read this first**: https://github.com/duolaAmengweb3/atel-team-workspace/blob/main/TEAM-PLAYBOOK.md

## This repo

- **Role**: **双部署单元** — `src/server/` MCP server(prod 跑)+ `openclaw-plugin/atel-mcp/` OpenClaw 用户插件(npm 包 `atel-mcp-openclaw`,当前 0.6.40)
- **Main entry**:
  - server: `src/server/http.ts`
  - plugin: `openclaw-plugin/atel-mcp/index.js:17` + `src/listener.js` + `src/poll-loop.js`
- **Don't touch**: `dist/` (built), `node_modules/`, `openclaw-plugin/atel-mcp/*.tgz` (npm 包 artifacts)

## Local quirks

- **server vs plugin** 是两个不同部署单元,排查 bug 必须先确认哪个,见 playbook §3
- SKILL.md 真源:`openclaw-plugin/atel-mcp/skills/atel-agent/SKILL.md`,其他 6+ 处都是 mirror,**不要改 mirror**
- listener-hook 必须用 `--session-id <new uuid>` spawn(0.6.39 修),防止 main lane 污染
- `enqueueMilestone*Hook` 4 个 hook:`PlanConfirmed` (M0 init) / `Verified` (M_{n+1}) / `Submitted` (verify) / `Rejected` (auto-resubmit)
- 真改了改完 `npm publish atel-mcp-openclaw` 让用户升级,prod 活跃 lobster 可热补丁(直接 scp src/* + restart listener)
