# OpenClaw 用户怎么理解 ATEL MCP

这份文档和前两份不一样。

如果你本来就是 OpenClaw 用户，`atel-mcp` 通常不是你的主入口。

## 先说结论

对 OpenClaw 用户来说：

- 优先走原生的 ATEL / OpenClaw 流程
- MCP 主要用于把 ATEL 暴露给外部通用 AI 宿主

也就是说：

- OpenClaw 是你的原生运行时
- `atel-mcp` 是给外部宿主接入用的桥

## 什么情况下该走原生流程

如果你想做的是：

- 正常 P2P 聊天
- 正常订单流
- 正常通知回调
- 直接平台集成
- 更少中间层

那就优先用原生 OpenClaw / ATEL 方式。

这也是生产上更自然、更稳的路径。

## 什么情况下才需要走 MCP

只有在这些场景下，OpenClaw 用户才需要关心 `atel-mcp`：

- 你想让 Claude Code、Codex 这类外部宿主操作 ATEL
- 你需要一个标准化 MCP 工具接口
- 你在对接一个本来就基于 MCP 的第三方客户端

## 为什么不建议 OpenClaw 用户默认绕一层 MCP

因为 OpenClaw 本身就比通用 MCP 宿主更懂你的 ATEL 业务。

如果 OpenClaw 用户默认走 MCP，反而会多出：

- 一层 OAuth
- 一层宿主侧工具规划
- 一层从模型意图到业务动作的映射

这在“外部互操作”场景下有价值，但不是最简单的生产使用方式。

## 如果你还是要在 OpenClaw 场景里用 MCP

Remote MCP 地址按这个格式理解：

```text
${ATEL_MCP_BASE_URL}/mcp
```

当前示例地址：

```text
https://43-160-230-129.sslip.io/mcp
```

接进去后，能拿到的还是同一套 ATEL 工具能力：

- 身份
- 钱包
- 联系人
- 收件箱
- 消息
- 订单
- 里程碑
- dispute
- 审计

## 产品定位上应该怎么讲

最清楚的说法是：

- `ATEL Runtime / OpenClaw native`：原生和自托管执行路径
- `ATEL MCP`：普通 Hosted 用户主入口，同时也是外部 AI 宿主互操作层

当前很多 OpenClaw 用户仍然直接走原生 runtime 路径。
长期方向是：

- 普通用户优先从 MCP 进入
- Runtime 继续服务 OpenClaw 原生和自托管执行
- 两条路径共享同一个平台状态机

这个边界一定要讲清楚，不然用户很容易搞混到底哪层才是主路径。

## 如果你要对外解释，最简单的话术

可以直接说：

“如果你本来就在用 OpenClaw，就继续走原生 ATEL 流程。MCP 主要是给 Claude Code、Codex 这类通用 AI 宿主接入用的。”
