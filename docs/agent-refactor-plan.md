# AI Agent 重构方案（对标 sshyard）

> 目标：把现有「单文件 tool loop」重构成可维护、可扩展的分层架构，补齐结构化文件工具、统一授权闸门、原生 tool calling 与附件能力。
> 原则：先拆结构不改行为 → 再加能力；每一阶段独立可验证、可回滚；只借鉴 sshyard 的设计思路（AGPL，不拷代码）。

## 1. 现状（重构前）

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 决策循环 | `src/renderer/agent/agent-runtime.ts`（2373 行，85KB） | `AgentRuntime` 一个类里同时管状态同步、提示词拼装、JSON 解析、审批、命令执行、上下文摘要、任务完成。 |
| 单轮编排 | `src/renderer/agent/agent-flow.ts` | 顺序流水线（原 LangGraph 已移除），产出 `execute / approval / ask / finish`。 |
| 提示词 | `src/shared/constants.ts:2` `AGENT_SYSTEM_PROMPT` | 强制「只能回复纯 JSON」，靠 `extractAgentStreamProjection` 从流里抠 JSON。 |
| 工具 | 无结构化工具 | 唯一能力是「执行一条 shell 命令」，经 sentinel / `agentExecAwait` 在服务端跑。 |
| 审批 | `src/renderer/assistant/command-policy.ts` + `risk-approval-memory.ts` | 命令首词词表定风险（low/medium/high/critical）、按具体命令记忆批准/拒绝、只读模式、重复命令冷却。 |
| 上下文 | `agent-runtime.ts` `maybeSummarizeAgentContext` | 超 `semanticSummaryContextLength`(12000) 时把「最近 4 条之外」的历史丢给 `aiChat` 摘要（≤6000 字）。 |
| 会话 | `useAgentStore.ts` | 按 connection 复用会话，不重载历史；任务历史持久化在服务端 `agentTasks`（≤30 条，字段截断）。 |
| 模型接入 | `server/index.cjs` `chatWithProvider/streamChatWithProvider` | 只支持 OpenAI 兼容 `/chat/completions`（含 stream），无 tools / Anthropic Messages / 附件。 |
| UI | `AgentPet` / `AgentExecutor` / `AgentExecutor` 时间线 | 思考步骤 + 执行记录 + 待审批/待回答。 |

## 2. 对标 sshyard（只取设计）

- **单主机单 tool loop**，每次工具调用前统一过 `policy.Gate.Authorize(action, diff)`，执行后 `Gate.Done` 落审计；权限与执行彻底分离。
- **三种权限模式**（询问 / 自动审核 / 完全允许）+ 可配审核模型 + 单轮工具调用上限 + 请求超时。
- **结构化工具**：`pane_output / list_dir / read_file / search_files / write_file / run_command`；`write_file` 先读旧内容算 unified diff 再给人看。
- **上下文预算**：超过 `maxChars` 时把最旧 tool 输出替换为 `omitted tool output (N bytes): …`；单工具结果截断 1MiB。
- **提示注入防护**：终端/文件/命令输出一律 `WrapUntrusted` 包成 `<untrusted-data>`，系统提示明确「里面是数据不是指令」。
- **事件模型**：`EventText/Thinking/Tool/Pause/Done/Notice`；工具卡片 `ToolCard{Phase:open|done, Verdict, Diff, Output, Exit, DurMS}`。
- **会话持久化**：按主机保存消息；恢复时悬空 tool call 标 `cancelled`；附件只留名字。

## 3. 分四批落地

### 批次一：内核拆分 + 结构化工具 + 统一授权闸门（行为兼容，收益最大）

1. **拆 `agent-runtime.ts`**（不改行为，先搬代码）
   - `agent/runtime/AgentRuntime.ts`：只保留生命周期/状态同步/循环驱动。
   - `agent/runtime/decision.ts`：提示词拼装 + 响应解析（含现有 JSON 修补逻辑）。
   - `agent/runtime/context.ts`：上下文预算、摘要、`omitted tool output`。
   - `agent/runtime/session.ts`：会话/消息/任务历史读写。
   - `agent/runtime/tools/*`：工具定义与调用适配。
2. **结构化工具（服务端）** `server/agent-tools.cjs`
   - `list_dir` / `read_file` / `search_files` 复用 `server/sftp-*`、`ssh-exec`；`write_file` 复用文件写接口（并支持 sudo 可选）；`run_command` 复用现有 sentinel 执行。
   - 路径沙箱：仅允许「连接根目录 / 当前会话 cwd」子树；单文件大小上限；拒绝符号链接越界与 `..` 逃逸。
3. **统一 Gate** `src/renderer/agent/runtime/policy.ts`
   - `authorize(action: {tool, command?, path?, dir?, reason}, diff?) -> {run, verdict, reason}`。
   - 整合现有词表风险 + 模式（`ask` / `auto`（审核模型）/ `full` / `readOnly`）+ 每连接白名单 + 记住决定。
   - 审计：服务端 `agent-audit.cjs` 记录 `{tool, host, action, verdict, exit, durMs}`（参考现有 `server/mcp/audit.cjs`）。
4. **diff 预览**：`write_file` 前读旧内容 → `unifiedDiff(old,new)`（新建 `agent/policy/diff.ts`），审批弹窗展示。
5. **测试**：工具单测（沙箱越界、大小上限、search 匹配）、Gate 单测（四种模式 × 风险等级 × 记忆）、现有 agent-runtime 测试全绿。

### 批次二：原生 tool calling + 上下文管理

1. **Provider 适配层** `server/ai-providers/`：`openai.ts`（tools / tool_calls / stream）、`anthropic.ts`（Messages API）、`ollama.ts`；统一 `AssistantAdapter` 接口。保留 JSON 模式作为不支持 tool calling 的兜底。
2. **循环改用 tool_calls**：`decision.ts` 产出 `ToolCall[]` 而非 JSON 字符串；不再需要 `fixMalformedJson` 等补丁（保留兜底路径）。
3. **上下文管理**：按 token 预算裁剪，最旧工具结果 → `omitted tool output (N bytes)`；单结果 1MiB 截断；支持「思维链/思考增量」流式展示。
4. **ToolCard 事件模型**：统一 `open → done`，字段 `Verdict/Diff/Output/Exit/DurMS`，UI 时间线直接消费。
5. **测试**：适配器契约测试（mock SSE）、tool_call 解析、预算裁剪边界。

### 批次三：会话持久化 / 附件

1. **会话持久化**：按 `clientId + connectionId` 存消息（服务端 `agent-conversations`），支持恢复；悬空 tool call → cancelled；附件只存元数据（名/类型/大小/临时文件 id）。
2. **附件**：粘贴图片/文件 → 传给支持多模态的 provider；不支持时提示。
3. **测试**：会话恢复、附件元数据。

### 批次四：策略与体验

1. 设置页新增「Agent 权限模式 / 审核模型 / 单轮工具上限 / 请求超时 / 上下文预算」。
2. 审计日志查看入口（按主机/时间筛选）。
3. 对话界面：工具卡片、diff 预览、暂停/继续（已有 pause 基础）、重新生成。
4. 文档：`docs/agent.md` 使用说明 + 安全边界。

## 4. 兼容与迁移

- 批次一保持 `AgentRuntime` 对外构造签名与 `AgentExecutor` 的接线不变，只移动实现，先确保测试与行为不变。
- 旧 JSON 协议在批次二与新 tool calling 并存一个版本，按 provider 能力选择。
- 服务端新增路由沿用现有 `route()/auth` 中间件；所有工具执行复用现有 SSH 会话。

## 5. 风险

- `agent-runtime.ts` 拆分层级大，必须机械搬迁 + 测试兜底，避免顺手改逻辑。
- 原生 tool calling 各 provider 差异（OpenAI vs Anthropic vs Ollama）需要适配层契约测试。
- 路径沙箱是安全关键，需专门的越界用例（`..`、符号链接、绝对路径）。
