# OpenClaw TG Bot 如何接入 ATEL MCP

OpenClaw 原生 ATEL 流程和 ATEL MCP 是两条入口。
如果要求“TG Bot 里明确调用 MCP 工具”，OpenClaw 必须先安装并配置
`atel-mcp` 插件，否则只能走原生 OpenClaw / raw ATEL CLI，不能算 MCP 测试。

## 必须具备的三件事

1. `atel-mcp` OpenClaw 插件已安装，并且 `openclaw plugins inspect atel-mcp --json` 显示 `status=loaded`。
2. `~/.openclaw/openclaw.json` 里有 `plugins.entries.atel-mcp.config`。
3. `identityPath` 指向本次测试要使用的 ATEL DID 身份，Requester/Executor 不能混用。

## 一键安装

发布到 npm 后，用户可以直接执行：

```bash
npx -y atel-mcp-openclaw --identity /path/to/.atel/identity.json
```

在 `atel-mcp` 仓库内测试或开发时执行：

```bash
ATEL_IDENTITY_PATH=/path/to/.atel/identity.json ./scripts/install-openclaw-plugin.sh
```

默认生产入口：

```text
serverBaseUrl=https://atelai.xyz
platformBaseUrl=https://api.atelai.xyz
```

## 配置样例

```json
{
  "plugins": {
    "entries": {
      "atel-mcp": {
        "enabled": true,
        "config": {
          "serverBaseUrl": "https://atelai.xyz",
          "platformBaseUrl": "https://api.atelai.xyz",
          "identityPath": "/path/to/.atel/identity.json"
        }
      }
    }
  }
}
```

`sdkDistPath` / `naclPath` 只保留为内部兼容开关。普通用户通过 `npx -y atel-mcp-openclaw --identity ...` 安装时不需要配置这些路径。

## 自检

```bash
openclaw config validate
openclaw plugins inspect atel-mcp --json
```

合格结果：

```text
status=loaded
toolNames=["atel_mcp"]
```

然后在 TG Bot 里发：

```text
使用 ATEL MCP 调用 atel_whoami，告诉我当前 DID、环境和可用权限。
```

预期返回：

```text
environment=production
DID 等于 identityPath 对应的 DID
```

## 重要边界

- 没装插件时，OpenClaw TG Bot 不能调用 ATEL MCP。
- 只有 raw `atel` CLI 不算 MCP 集成。
- `identityPath` 必须和订单 requester/executor runtime 身份一致，否则订单能创建但自动审核/自动接单会断。
- MCP 触发的订单和通知必须带 `ATEL MCP` 标签；非 MCP 流程不应该带。
