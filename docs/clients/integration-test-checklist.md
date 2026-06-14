# MCP 真 host 接入测试清单 (G1 验收)

> **目标**: 用一个真 Claude Desktop（或 Cursor）从零接入 ATEL MCP，跑完整 a2a 一笔订单。
>
> **预计耗时**: 5-10 分钟（开发已预跑过整个流程，所有可预见的坑都修了）
>
> **前置**: 你需要有一个 **TLS 域名指向 atel-mcp**。测试服只有 http，不能直接用。三个选项见 § 0。

---

## § 0 准备 TLS 接入点（必做）

Claude Desktop / Cursor 都拒绝 `http://` MCP server。三种方法任选其一：

### 方法 A: Cloudflare Tunnel（推荐，免费 + 5 分钟搞定）

在测试服上：

```bash
# 安装
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared.deb

# 启动隧道（不需要 CF 账号 — 自动给你一个 *.trycloudflare.com URL）
cloudflared tunnel --url http://localhost:8787
```

终端会输出类似：
```
Your quick Tunnel has been created! Visit it at:
https://abc-def-xyz.trycloudflare.com
```

把那个 URL 当 MCP base 用。**注意**：进程退出 URL 就废，每次重启都换。临时测试合适。

### 方法 B: ngrok（备选）

```bash
ngrok http 8787
# 输出 https://xxxx.ngrok-free.app
```

### 方法 C: 真 DNS + Let's Encrypt（生产路径，半小时）

1. 把 mcp-test.atelai.xyz A 记录指 144.202.53.72
2. 在测试服 `certbot --nginx -d mcp-test.atelai.xyz`
3. nginx 加 vhost 反代 `proxy_pass http://127.0.0.1:8787`

---

## § 1 配 Claude Desktop

编辑配置：
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "atel-test": {
      "transport": "streamable-http",
      "url": "https://你的TLS域名/mcp"
    }
  }
}
```

完全退出 Claude Desktop（不是关窗口，是 Cmd+Q），重启。

## § 2 第一次 OAuth 认证

1. Claude 里随便问："列一下我能用的 atel 工具"
2. Claude 弹一个浏览器页面 — 上面会显示一个 6 字符代码（例 `KX5VZ5`）
3. 在另一台已经有 ATEL 身份的设备上跑：
   ```bash
   # 如果你有 ATEL CLI 和 identity.json
   atel auth KX5VZ5
   ```
4. 浏览器页面自动跳转完成 → Claude 拿到 token

**没有 ATEL 身份**怎么办：在 Claude 里直接说 "帮我注册一个新 ATEL 身份"，Claude 会调 `atel_register_user` 给你一个 DID + secretKey + recoveryCode（**记得保存**）。这条路不需要任何已有身份。

## § 3 5 步 happy path 验证

逐条让 Claude 做：

| # | 命令 | 期望结果 |
|---|---|---|
| 1 | "查一下我的 atel 余额" | 调 `atel_balance` 返各链余额 |
| 2 | "搜索 capability=writing 的 agent" | 调 `atel_agent_search` 返 agent 列表 |
| 3 | "找一个 agent 创建 0.01 USDC 的 writing 订单，描述：测试" | 调 `atel_order_create` 返 order_id |
| 4 | "看下这个 order 的 milestone" | 调 `atel_milestone_list` |
| 5 | "查我的 audit log" | 调 `atel_audit_session_get` 看到前面 4 步全在 |

每步如果 Claude 卡了，让它把 raw response 贴出来 — 错误码里会有 actionable hint 提示下一步。

## § 4 已知踩坑（开发已修，只为参考）

| 现象 | 根因 | 已修 |
|---|---|---|
| 调任何 tool 返 ENVIRONMENT_MISMATCH | platform `ATEL_ENV_PROFILE=development` 跟 MCP enum 不对应 | ✅ MCP 5/6 修：dev/staging/test 都映射 local-test，加 ALLOW_CUSTOM_REMOTE_MCP=true 放行 |
| OAuth 浏览器页面 404 | mcp publicBaseUrl 配错 | ✅ 现 publicBaseUrl 就是 mcp 自己的 URL，TLS proxy 时会自动正确 |
| tools/list 返空 | bearer 解析挂 | ✅ 现 introspection 兼容 OAuth 路径 + DID-Sig 路径 同 jwtSecret |
| Claude Desktop "Failed to start server" | transport=streamable-http 需要 ≥0.7 版本 | 用户：升级 Claude Desktop |

## § 5 验收交付物

跑完后，请记录：
- [ ] 第 § 2 一次走通（截图浏览器页面）
- [ ] 第 § 3 五个步骤全部成功（贴 Claude 的回复）
- [ ] 任何卡住 / 文档写不清的点 — 请反馈，开发会补到这份 doc

如果完整跑通 = G1 通过 = 可上 G12 生产。

---

## 附录: 自动化 verification script

接通后跑这个验证 50+ tools 都正常：

```bash
# 在你电脑上（测试服没装 Python 库的话）
pip install pynacl
git clone https://github.com/AtelLab/atel-sdk
cd atel-sdk
MCP_URL=https://你的TLS域名/mcp PLATFORM_URL=http://144.202.53.72:8200 \
  npx tsx scripts/test-mcp-connect.ts
```

期望输出：
```
✓ token obtained in ~500ms
✓ tools count: 52
✓ MCP accepts DID-Sig-issued JWT as bearer
🎉 G2 e2e PASSED
```
