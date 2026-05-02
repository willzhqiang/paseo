# Cursor SDK 学习与研究笔记

> 基于 https://cursor.com/docs/sdk/typescript 和 https://github.com/cursor/cookbook
> 版本：@cursor/sdk@1.0.12（Public Beta，API 可能变化）

---

## 一、SDK 核心概念

| 概念 | 说明 |
|------|------|
| **Agent** | 持久容器，持有对话状态、workspace 配置。跨多次 prompt 存活 |
| **Run** | 一次 prompt 提交。拥有自己的 stream、status、result、cancellation |
| **SDKMessage** | 标准化流式事件，所有 runtime 形状一致 |

## 二、两种 Runtime

```typescript
// 本地：agent 在你的 Node 进程内运行，读写磁盘文件
const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2" },
  local: { cwd: process.cwd() },
});

// 云端：agent 在 Cursor 托管的 VM 里运行，自动 clone repo
const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2" },
  cloud: {
    repos: [{ url: "https://github.com/your-org/repo", startingRef: "main" }],
    autoCreatePR: true,
  },
});
```

Runtime 通过传入 `local` 或 `cloud` 选择，API 调用方式完全一样。

## 三、鉴权

```bash
export CURSOR_API_KEY="crsr_..."
```

- 从 [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations) 获取 User API Key
- 或从 Team Settings 创建 Service Account API Key
- Team Admin API Key 暂不支持

## 四、核心 API

### 创建 & 恢复

```typescript
// 创建新 agent
const agent = await Agent.create(options: AgentOptions);

// 恢复已有 agent（自动检测 runtime：bc-前缀=cloud，其他=local）
const agent = await Agent.resume(agentId, options?);

// 一次性：创建→发送→等待→销毁
const result = await Agent.prompt("task description", options);
```

### 发送消息 & 流式输出

```typescript
const run = await agent.send("Fix the auth bug");

// 方式一：流式（主流）
for await (const event of run.stream()) {
  switch (event.type) {
    case "assistant": // 模型文本输出
    case "thinking":  // 推理内容
    case "tool_call": // 工具调用（running/completed/error）
    case "status":    // 云端生命周期
    case "task":      // 任务里程碑
  }
}

// 方式二：等待完成
const result = await run.wait();
// result: { id, status, result?, model?, durationMs?, git? }

// 方式三：结构化对话历史
const turns = await run.conversation();
// turns: ConversationTurn[] (agentConversationTurn | shellConversationTurn)
```

### 取消

```typescript
await run.cancel();
// run.status → "cancelled"
// 部分输出保留在 Run 对象上
```

### 模型切换

```typescript
// 在 send 时传 model，会 sticky 更新 agent.model
const run = await agent.send("refactor", {
  model: { id: "composer-2", params: [{ id: "thinking", value: "high" }] },
});
// 之后的 send 会继续使用这个 model
```

### 原始 Delta 回调

```typescript
const run = await agent.send("task", {
  onDelta: ({ update }) => {
    // InteractionUpdate 类型（比 SDKMessage 更细粒度）：
    // text-delta, thinking-delta, thinking-completed,
    // tool-call-started, tool-call-completed, partial-tool-call,
    // token-delta, turn-ended (含 usage), shell-output-delta, ...
  },
  onStep: ({ step }) => {
    // ConversationStep: assistantMessage | toolCall | thinkingMessage
  },
});
```

**重要**：`TurnEndedUpdate` 里的 `usage` 是获取 token 用量的唯一方式：
```typescript
{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
```

### 检查 Agent 和 Run

```typescript
// 列出 agents
const { items, nextCursor } = await Agent.list({ runtime: "local", cwd: "..." });

// 获取单个 agent 信息
const info = await Agent.get(agentId);

// 列出某 agent 的 runs
const { items } = await Agent.listRuns(agentId, { runtime: "local" });

// 获取单个 run（cloud 需要 agentId）
const run = await Agent.getRun(runId, { runtime: "local" });
```

### 模型列表

```typescript
const models = await Cursor.models.list();
// SDKModel: { id, displayName, description, parameters?, variants? }
// parameters: ModelParameterDefinition[] (如 thinking: low/high)
// variants: ModelVariant[] (预设参数组合)
```

## 五、MCP 服务器

```typescript
const agent = await Agent.create({
  // ...
  mcpServers: {
    // stdio 类型
    filesystem: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
    },
    // HTTP 类型（支持 OAuth）
    docs: {
      type: "http",
      url: "https://example.com/mcp",
      auth: { CLIENT_ID: "...", scopes: ["read"] },
    },
  },
});
```

本地 agent 还会从 `.cursor/mcp.json` 和 `~/.cursor/mcp.json` 加载（需配置 `settingSources`）。

## 六、Subagents

```typescript
const agent = await Agent.create({
  // ...
  agents: {
    "code-reviewer": {
      description: "Expert code reviewer",
      prompt: "Review code for bugs and security issues.",
      model: "inherit", // 使用父 agent 的模型
    },
  },
});
```

也可以通过 `.cursor/agents/*.md` 文件定义。

## 七、Hooks

SDK 不支持编程式 hook 回调。通过文件定义：

- 项目级：`.cursor/hooks.json`
- 用户级：`~/.cursor/hooks.json`

配置 `settingSources: ["project", "user"]` 让本地 agent 加载。

## 八、资源管理

```typescript
// 推荐：await using 自动销毁
await using agent = await Agent.create({ ... });

// 或手动
await agent[Symbol.asyncDispose]();
```

## 九、错误处理

所有错误继承 `CursorAgentError`：

| 错误类 | 场景 |
|--------|------|
| `AuthenticationError` | API Key 无效 |
| `RateLimitError` | 请求过多 |
| `ConfigurationError` | 无效模型/参数 |
| `IntegrationNotConnectedError` | SCM 未连接 |
| `NetworkError` | 服务不可用 |
| `UnsupportedRunOperationError` | 操作在当前 runtime 不支持 |

```typescript
try { ... } catch (e) {
  if (e instanceof CursorAgentError && e.isRetryable) { ... }
}
```

## 十、已知限制（1.0.12 版本）

- `mcpServers` 不跨 `Agent.resume()` 持久化（需重新传入）
- 本地 agent 不支持 `listArtifacts()` / `downloadArtifact()`
- `settingSources` 不适用于云端 agent
- Hooks 仅文件定义，无编程回调
- Tool call 的 `args` / `result` schema 不稳定（随工具演进变化）

## 十一、与 Anthropic Claude SDK 的对比

| 维度 | Cursor SDK | Anthropic Claude Agent SDK |
|------|-----------|---------------------------|
| 权限控制 | 文件级 hooks | SDK 级回调（`canUseTool`） |
| Context window | 不暴露 | 实时 `task_progress` |
| 模式切换 | 无 | plan/default/bypass |
| Compaction | 无 | 有事件 |
| Usage 获取 | `TurnEndedUpdate` | `result.usage` + `task_progress` |
| 历史格式 | `ConversationTurn[]`（结构化） | JSONL 文件（需自行解析） |
| 持久化 | `Agent.list()` / `Agent.resume()` | JSONL session 文件 |
| 取消 | `run.cancel()` | `query.interrupt()` |
| 模型列表 | `Cursor.models.list()` | 内置常量 + SDK config |

**结论**：Anthropic SDK 暴露更多底层控制（权限、compaction、context window），但 Cursor SDK 的 `Agent.list()` / `Agent.resume()` / `run.conversation()` 在会话管理层面更现代、更结构化。两者是不同的设计哲学——Anthropic 给你最大控制权，Cursor 给你最佳默认行为。

## 十二、参考

- [官方 SDK 文档](https://cursor.com/docs/sdk/typescript)
- [Cookbook 示例](https://github.com/cursor/cookbook)
- [Coding Agent CLI 示例](https://github.com/cursor/cookbook/tree/main/sdk/coding-agent-cli)
- [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)
- [changelog](https://cursor.com/changelog)
