# LangGraph 拆除评估

> **状态：已于 2026-09-10 执行完毕（保留本文作为决策与结果记录）。**
>
> 实际结果：前端 JS **1668.7 kB → 843.7 kB（-49.4%）**；最大 chunk **827.7 kB → 303.6 kB**（xterm，Vite 的 >500 kB 告警消失）；`@langchain/langgraph` 与 `@langchain/core` 已从依赖树移除；31 个契约测试在实现重写后**一行未改**即全部通过。§3.2 记录的中止语义缺陷已先期单独修复并加回归防线。

> 评估日期：2026-09-10
> 评估对象：`src/renderer/agent/langgraph-agent-flow.ts`（433 行）及其 `@langchain/langgraph` / `@langchain/core` 依赖
> 原始结论：**技术上完全可行且风险可控，收益 ≈ 827.7 KB JS（gzip 226.5 KB）。但这是一个产品路线图决策，不是纯技术决策。**

---

## 1. 结论摘要

| 维度 | 评估 |
|---|---|
| 技术可行性 | **完全可行** —— 两个图都是严格线性流水线，未使用任何图特性 |
| 收益 | 消除 827.7 KB 懒加载 chunk（占前端 JS 总量 1668.7 KB 的 **49.6%**，gzip 226.5 KB），并移除 2 个 npm 依赖树 |
| 工作量 | **1–2 人日**（替换 + 验证）；若补测试锁定行为，**+0.5–1 人日** |
| 风险 | **中低** —— 位于 Agent 执行主路径，但已有 `test/agent-flow.test.ts` 29 个用例作为安全网（并经变异测试验证有效性）；唯一待决项是 §3.2 记录的「暂停被判失败」中止语义不一致 |
| 建议 | 若路线图无「条件路由 / 人工介入中断 / 检查点续跑」计划 → **建议拆除**（先修 §3.2 缺陷）；若有 → **保留**，见 §7 |

**核心判断依据**：本文件第 172-174 行已经把 LangGraph 编译产物 `as` 成了 `AnyCompiledGraph`（仅 `invoke(state) => Promise<state>`）。**代码本身早已把它当作一个不透明黑盒函数**，说明抽象边界已经存在于「一个接收 state 返回 state 的函数」。替换因此是机械的。

---

## 2. 现状：LangGraph 特性实际使用面

### 2.1 依赖引用面

全仓库 `@langchain/*` 只出现在**一个文件的两行 import**：

```
src/renderer/agent/langgraph-agent-flow.ts:1: import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
src/renderer/agent/langgraph-agent-flow.ts:2: import { tool } from '@langchain/core/tools';
```

版本：`@langchain/langgraph@1.3.2`、`@langchain/core@1.1.48`。

### 2.2 图拓扑：两条直线

```
ExecutionGraph  START → executeCommand → observeOutput → prepareNextDecisionContext → END
RoundGraph      START → prepareContext → callModel → parseModelResponse → routeDecision → executeAction → END
```

`RoundGraph` 的编译结果被模块级单例缓存（第 176、290-291 行）；`ExecutionGraph` 则**每次调用都重新编译**（第 191-232 行在函数体内，见 §6 附带发现）。

### 2.3 LangGraph 特性使用清单（逐项实测）

| 特性 | 使用数 | 说明 |
|---|---|---|
| `addConditionalEdges` | **0** | 无分支，所有边都是无条件 `addEdge` |
| 环 / 回边 | **0** | 无环，DAG 退化为链 |
| `interrupt` | **0** | 无人工介入中断 |
| `checkpointer` / `MemorySaver` | **0** | 无检查点、无状态持久化、无续跑 |
| `.stream()` / `streamMode` | **0** | 只用 `.invoke()`；LLM 流式是经回调 `onStreamEvent` 传入节点（第 300 行），**不依赖图流式** |
| `Send()` / map-reduce | **0** | 无并行扇出 |
| 子图 / 嵌套图 | **0** | 无 |
| 重试策略 / 超时策略 | **0** | 无 |
| reducer 归并 | **0** | 全部 `Annotation<T>()` 默认语义 = **last-value-wins** |
| 递归上限 | 未触及 | 默认 25，实际深度 5 |
| LangSmith / tracing | **0** | 仓库内无任何 tracing 配置 |

### 2.4 状态语义 = `Object.assign`

所有通道都是 `Annotation<T>()` 无 reducer，节点返回**部分状态**，由运行时浅合并。这与：

```ts
Object.assign(state, patch);
```

**语义完全等价**。两点边界情况也一致：

- 返回 `{}`（第 393 行 `executeAction` 非 execute 分支）= 空补丁，无副作用。
- 节点内 `throw` 会中止后续节点并向上冒泡（见 §3.2）。

### 2.5 `tool()` 是仪式性包装

第 50-102 行定义了两个 `tool()`，但**从未 bind 给任何模型**，只被本地 `.invoke()` 自调用：

```ts
const requestCommandApprovalTool = tool(async (input) => ({ type: 'approval', ... }), {
  name: 'request_command_approval',
  description: 'Ask the user to approve a risky shell command before execution.',
  schema: { /* ... */ },
});

async function requestCommandApproval(input) {
  return requestCommandApprovalTool.invoke(input);   // ← 包装后只自调用
}
```

其 `name` / `description` / `schema`（JSON Schema）**没有任何消费者** —— 不存在「把工具列表交给 LLM 由其决定调用」的路径。这 53 行可直接内联为返回字面量对象的普通函数，同时移除 `@langchain/core` 依赖。

---

## 3. 行为等价性分析（关键技术风险点）

替换必须逐条保住以下语义，否则会产生静默行为漂移。

### 3.1 状态累积可见性

每个节点看到的是**此前所有节点合并后的状态**（如 `observeOutput` 读 `state.error`，而 `error` 由 `executeCommand` 写入）。顺序执行 + 逐步浅合并即可复现。

> ⚠️ 注意：LangGraph 传给节点的是本轮状态快照，节点直接改它不会生效。替换实现若把**同一个 state 对象**传给节点，则节点直接改它**会**生效（行为的超集）。本文件现有节点都只返回补丁、从不直接改 state，所以无差异；但替换实现应在注释中写明这一约定，避免后人写出依赖「直接改 state」的代码。

### 3.2 错误传播路径

这是最需要小心的部分：

| 位置 | 行为 | 替换后必须保持 |
|---|---|---|
| `callModel` 抛错（第 304 行） | 冒泡出 `invoke()`，被 `agent-runtime.ts:1446` 的 catch 捕获；若任务版本已变则转成 `AbortedByRuntimeError('AI stream canceled')` | 抛错必须继续冒泡，**不可**被吞成 `result.error` |
| `executeAction` 遇 `AbortedByRuntimeError`（第 409-411 行） | **重新抛出**，不写入 `execution.error` | 必须继续重抛；`agent-runtime.ts:1084` 依赖它区分「被中止」与「执行失败」 |
| `executeAction` 其他错误（第 408-422 行） | 捕获并写入 `execution.error`，流程继续到 END | 保持捕获 |

即：**「中止」类错误贯穿冒泡，「业务」类错误就地捕获**。这条分界线目前是靠 `error.name === 'AbortedByRuntimeError'` 字符串判断 + 图外 `instanceof` 双重体现的，替换时不得改错。

> ⚠️ **已确认缺陷：两个图对中止错误的处理并不一致。**
>
> `runAgentExecutionGraph` 的 `executeCommand` 节点（第 196-201 行）用裸 `catch` 捕获**所有**错误，包括 `AbortedByRuntimeError`，把它降级成 `{ error }` 并正常 resolve。于是 `agent-runtime.ts` 第 1076 行 `throw new Error(result.error)` 重新包出的已是**普通 Error**（`name` 变成 `'Error'`），第 1084 行的 `instanceof AbortedByRuntimeError` **不命中**。
>
> 该路径**可达且已定位复现链**：`applyPause()`（`agent-runtime.ts:1224`）→ `abortActiveWork('paused')` → cancel token 触发 → `executeCommandAndWait` 抛 `AbortedByRuntimeError('paused')`（第 1648 行）→ 被 `executeCommand` 吞掉 → 回到第 1084 行判为非中止；而 `applyPause()` **不递增 `taskVersion`**，第 1087 行的 `isCurrent(capturedVersion)` 兜底同样不生效 → 落到 1088-1092 行把思考步骤标记为失败、记录一次失败执行、并 `finishTask(false, msg)`。
>
> **用户可见后果：Agent 正在执行命令时点击「暂停」，任务会被判定为失败（并追加一条失败执行记录），而非干净地暂停。**
>
> 此不一致已被 `test/agent-flow.test.ts` 以「`[已知缺陷]`」用例显式固化，避免重构时被无声改变或误当作期望行为。修复方式是在 `executeCommand` 节点内镜像 round 图的重抛判断：
>
> ```ts
> if (error instanceof Error && error.name === 'AbortedByRuntimeError') {
>   throw error;
> }
> ```

### 3.3 `executeAction` 的条件短路

第 391-394 行：`nextAction.type !== 'execute'` 时返回 `{}` 直接结束。这是唯一一处「节点内部提前返回」，替换为顺序代码时天然成立。

### 3.4 并发安全

`roundGraph` 是模块级单例，被所有 Agent 轮次共享，并发隔离依赖 LangGraph 的 per-invoke run 机制。替换为纯函数后**不存在共享可变状态**，并发安全性严格提升。

---

## 4. 替换方案

### 4.1 通用流水线助手（新增，约 12 行）

```ts
type NodePatch<S> = Partial<S> | void;
type Node<S> = (state: Readonly<S>) => NodePatch<S> | Promise<NodePatch<S>>;

/**
 * 顺序执行节点，浅合并每个节点返回的补丁。
 *
 * 约定：节点只返回补丁、不得直接修改 state（见 §3.1）。
 * 节点抛出的错误会中止剩余节点并向上冒泡（见 §3.2）。
 */
async function runPipeline<S extends object>(
  initial: S,
  nodes: Array<Node<S>>,
): Promise<S> {
  const state = { ...initial };
  for (const node of nodes) {
    const patch = await node(state);
    if (patch) Object.assign(state, patch);
  }
  return state;
}
```

### 4.2 ExecutionGraph（约 60 行 → 约 25 行）

```ts
interface ExecutionState {
  command: string;
  output?: string;
  observation?: string;
  nextDecisionContext?: string;
  error?: string;
}

export async function runAgentExecutionGraph(input: {...}): Promise<AgentExecutionGraphResult> {
  const s = await runPipeline<ExecutionState>(
    { command: input.command },
    [
      async (state) => {
        try {
          return { output: await input.execute(state.command) };
        } catch (error) {
          return { error: messageOf(error) };
        }
      },
      (state) => state.error
        ? { observation: state.error }
        : { observation: input.summarizeOutput(state.output || '') },
      (state) => state.error
        ? { nextDecisionContext: state.error }
        : { nextDecisionContext: input.buildNextDecisionContext(state.command, state.output || '') },
    ],
  );

  return {
    command: s.command,
    output: s.output || '',
    observation: s.observation || '',
    nextDecisionContext: s.nextDecisionContext || '',
    error: s.error,
  };
}
```

> 附带修掉 §6 的「每次调用重新编译」问题：不再有编译步骤。

### 4.3 RoundGraph（约 145 行 → 约 90 行）

5 个节点按序映射为 5 个函数，`routeDecision` 内的 if/else 链（第 322-390 行）**原样保留** —— 它本来就是普通条件语句，与图无关。`prepareContext`（第 294-296 行，仅做 `preparedMessages = messages` 的改名）可直接消除，在首节点读 `input.messages`。

同时删除 `getRoundGraph()`、`roundGraph` 单例、`AnyCompiledGraph` 类型，以及 `tool()` 两个定义（第 50-102 行）—— 内联为普通函数：

```ts
function requestCommandApproval(input: RequestCommandApprovalInput) {
  return Promise.resolve({
    type: 'approval' as const,
    response: input.response,
    command: input.command,
    riskLevel: input.riskLevel,
  });
}
```

### 4.4 收尾

- 文件更名 `langgraph-agent-flow.ts` → `agent-flow.ts`（原名将失去意义），更新 `agent-runtime.ts` 中 2 处动态 `import()`。
- `package.json` 移除 `@langchain/core`、`@langchain/langgraph`，重新 `npm install` 收缩 lock 与 `node_modules`。
- `agent-runtime.ts` 里 `AgentGraphAction` / `AgentRoundGraphResult` 等类型改为从新文件导入。

---

## 5. 工作量与验收

| 步骤 | 预估 |
|---|---|
| 1. 写入 `runPipeline` + 替换 ExecutionGraph | 1–2 h |
| 2. 替换 RoundGraph + 内联 tools + 文件更名 | 2–3 h |
| 3. 更新调用点与类型导入，`typecheck` 通过 | 0.5–1 h |
| 4. ~~补测试锁定行为~~ **✅ 已完成（2026-09-10）** | — |
| 5. **先决策并处理 §3.2 的中止语义缺陷** | 0.5 h |
| 6. 手工回归 5 条决策路径（测试已覆盖大部分，仍需端到端确认） | 1–2 h |
| 7. 移除依赖、重建、体积核对 | 0.5 h |
| **合计** | **0.5–1 人日**（测试安全网已就绪，比原估减少约 1 人日） |

**测试已完成**：`test/agent-flow.test.ts` 覆盖全部决策出口与中止语义（新增 29 用例，全套 146 项通过），使步骤 3 之后的重构有了自动化验收依据。原计划的人工回归 5 条路径中，除端到端链路外均已由用例锁定。

**端到端仍需人工确认的 5 条路径**（单元测试已锁定各出口的图内行为；以下确认的是「图 → `AgentRuntime` → UI」的整体链路）：

1. `execute` —— 正常命令下发，终端真实显示输出，思考步骤转为 completed
2. `approval` —— 高风险命令弹审批，批准后继续、拒绝后按策略走
3. `ask` —— 模型反问用户，用户答复后继续下一轮
4. `fail` —— 响应无法解析 → `retryParse`；重试不可用 → 任务以 fail 收尾
5. **中止** —— 任务执行中暂停 / 停止 / 关闭标签，确认任务**不被误判为失败**（此项目前会失败，见 §3.2）

**验收标准**：`npm run typecheck` 通过、`vitest` 117 项不回归、`build:renderer` 通过、上述 5 条路径在**桌面端与 Web 端各跑一遍**行为与改造前一致、`dist` 中不再出现 827.7 KB chunk。

---

## 6. 附带发现（无论是否拆除都建议处理）

### 6.1 主路径测试覆盖（2026-09-10 已补）

`test/` 下原有 22 个测试文件**没有任何一个**涉及 `agent-runtime.ts` 或图流程（集中在终端渲染、SFTP、鉴权、哨兵）。这曾是本次评估风险评级为「中」的**首要原因**。

现已新增 `test/agent-flow.test.ts`（29 个用例），直接锁定 `runAgentRoundGraph` / `runAgentExecutionGraph` 的**公开契约** —— 这两个函数在拆除后保持不变，是安全网的正确接缝。覆盖：

| 分组 | 覆盖内容 |
|---|---|
| 模型调用与上下文准备 | provider/messages/requestId 透传、流事件转发、原始内容透传、模型失败冒泡、空 data 冒泡 |
| execute 出口 | 命令路由与 execution 回填、`beforeExecute` 触发、命令 trim、普通错误就地捕获、**中止错误重抛** |
| approval 出口 | 高风险转审批且不执行、审批不触发 `beforeExecute`、`analyzeCommand` 参与判定 |
| ask 出口 | 反问转 ask、缺 question 时回退文案 |
| finish 出口 | 带/不带 `finishReason` 两种回退 |
| 失败与重试 | retryParse / fail、空内容视为解析失败、缺命令 fail 并附响应、重复命令拦截且**先于审批** |
| 图实例复用与并发 | 连续两轮不串状态、并发轮次各自正确（锁定模块级单例的隔离性） |
| execution 图 | 流水线字段回填、失败填充、失败时不调用摘要、`[已知缺陷]` 中止被吞 |

**有效性已验证（变异测试）**：对实现施加 9 处定向破坏（去掉 abort 重抛、重复命令检查失效、取消 trim、空响应也解析、审批检查失效、风险等级写死、失败时不再回填 observation / nextDecisionContext），**8 处被测试捕获，1 处因锚点不唯一跳过**。测试具备真实检错能力，不是「恒过」的空壳。

### 6.2 `runAgentExecutionGraph` 每次调用重新编译图

第 191-232 行在函数体内构造并 `.compile()` 图，而 `RoundGraph` 有单例缓存（第 290-291 行）。每次命令执行都要付一次图构建成本。**这是现存的小性能问题**，拆除后自然消失；若保留 LangGraph，应把编译提到模块级缓存。

### 6.3 两处节点是人为切分

`prepareContext` 只做字段改名；`parseModelResponse` → `routeDecision` 拆成两个节点之间**没有任何分支**，纯粹是把「解析」和「路由」分了两步。这些切分只有在需要条件边时才有价值。

---

## 7. 保留 LangGraph 的理由与决策建议

必须公平陈述反面：

1. **作者是有意为之的**。代码注释写着「the graph owns the execution transition and returns a plain result that can **later be chained** into observation/decision nodes」（第 189 行）、「This graph owns the orchestration shape for a full round」（第 255 行）。这是**为未来扩展预留的骨架**，不是误用。
2. **若路线图包含以下任一项，保留是正确选择**：
   - 条件路由 / 动态规划（模型自主决定下一步走哪个节点）
   - 人工介入中断（`interrupt` + 恢复）
   - 检查点与断点续跑（长任务持久化）
   - 并行子任务扇出（`Send` map-reduce）
   - LangSmith 可观测性 / 轨迹追踪
3. **重引入成本高于保留成本**：真要做上述能力时，手写调度器会迅速复现 LangGraph 的复杂度。

**决策建议**：向作者确认一件事 —— *未来 2–3 个迭代内，Agent 编排是否需要条件分支、中断、检查点或并行扇出？*

- **否** → 拆除。827.7 KB 换回约 50% 的前端 JS 体积，且拆除后若真需要，`npm i` 即可重来，损失可控。
- **是** → 保留，但**立即**做两件事：① 补 §6.1 的测试；② 修 §6.2 的重复编译。
- **不确定** → 保留 LangGraph，但**先做已完成的 chunk 隔离**（见 §8），并补测试。等路线图清晰再决策。

---

## 8. 已完成的先行优化（不依赖本决策）

2026-09-10 已落地，无论最终是否拆除都有效：

把纯函数 `estimateAgentMessagesTokens` 从 `langgraph-agent-flow.ts` 抽到无依赖的 `agent-token-estimate.ts`。此前 `agent-runtime.ts` 对前者的**静态导入**导致 LangGraph 被拽进 `AgentExecutor` chunk，使代码中两处刻意的 `await import()` 懒加载失效。

| Chunk | 改造前 | 改造后 |
|---|---|---|
| `AgentExecutor` | 841.7 KB | **32.9 KB** |
| `langgraph-agent-flow` | （混入上者） | **827.7 KB**（独立懒加载） |

收益是**缓存粒度**：LangGraph 作为稳定第三方依赖，其 chunk hash 现与业务代码解耦；此前改动 `agent-runtime` 任意一行都会让 841 KB 整体失效重下，现在只失效 33 KB。对 Web 端真实网络下载有实际意义。

**注意**：这一步**没有**减少总字节数 —— Agent 任务运行时两个 chunk 仍都会加载（两处动态导入都在执行必经路径上）。真正的体积削减只能由本文档 §4 的拆除达成。
