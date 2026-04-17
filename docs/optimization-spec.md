# AI SSH Client 优化规范

## 概述

本文档描述对 AI SSH Client 项目的优化方案，当前已不再只聚焦“代码质量 + 用户体验 + 连接稳定性”，还补充了 AI 模块在安全性、稳定性、可扩展性与可维护性方面的整改项。

本轮对照 `docs/ai-module-analysis.md` 后，已将原规范扩展为两条主线并行推进：

- **通用产品能力优化**：多会话、连接分组、终端增强、导入导出、主题等
- **AI 模块专项治理**：API Key 安全、AI 请求超时/取消、Provider 抽象、上下文管理、Agent 状态机、命令提取与风险复核等

---

## 第一部分：代码质量重构

### 1.1 消除重复代码

**问题**：类型定义和常量在 main 和 renderer 两处重复定义

**解决方案**：
- 创建 `src/shared/` 目录，统一存放共享代码
- 移动 `SSHConnection`、`AIProviderConfig`、`Message`、`CommandSuggestion` 等类型到 shared
- 移动 `IPC_CHANNELS`、`DANGEROUS_COMMANDS` 等常量到 shared
- 更新 import 路径

**文件变更**：
```
src/shared/
├── types.ts          # 所有共享类型定义
└── constants.ts      # 所有共享常量

src/main/
├── types.ts          # 删除，使用 shared/types.ts
└── constants.ts      # 删除，使用 shared/constants.ts

src/renderer/
├── types.ts          # 删除，使用 shared/types.ts
└── constants.ts      # 删除，使用 shared/constants.ts
```

### 1.2 Preload 脚本优化

**问题**：Preload 中硬编码了 IPC_CHANNELS，与 main/index.ts 不同步

**解决方案**：
- Preload 直接从 shared 导入常量
- 统一使用 `contextBridge` 暴露 API
- preload 暴露的方法返回精确类型，而不是 `any`
- 与 `src/shared/ipc-types.ts` 统一约束

### 1.3 IPC 契约统一

**问题**：主进程 handler、preload、renderer 对 IPC 返回结构使用不一致，存在 `any` 和自由结构

**解决方案**：
- 所有 IPC handler 统一返回 `IPCResult<T>`
- 共享 `AIChatResult`、`AIProvidersResult`、`SettingsImportResult` 等类型
- 渲染层只通过统一结果结构读取 `result.success / result.data / result.error`
- 减少“主进程返回什么，前端临时适配什么”的松散约定

### 1.4 共享类型收紧

**问题**：部分共享类型过于宽泛，例如 `AIProviderConfig.type: string`

**解决方案**：
- 将 provider 类型从裸 `string` 收紧为联合字面量或枚举
- 为不同 provider 定义能力描述与差异化配置
- 移除 `Array<any>`、裸对象等宽泛类型
- 为导入导出结构定义独立 schema 对应类型

---

## 第二部分：AI 模块专项优化

### 2.1 API Key 与敏感信息安全

#### 2.1.1 API Key 安全存储

**问题**：AI Provider 的 `apiKey` 明文保存在本地配置中

**解决方案**：
- 优先使用系统凭据存储保存 API Key（如 keytar / 系统凭据管理器）
- `electron-store` 仅保存 provider 元信息，不直接保存明文密钥
- 若短期内无法完全切换到凭据存储，至少先做本地加密与导出脱敏
- UI 默认掩码显示 API Key，仅在编辑时按需展示

#### 2.1.2 日志脱敏与分级

**问题**：AI 模块日志存在潜在敏感信息泄露面

**解决方案**：
- 建立统一 logger abstraction，区分 `debug / info / warn / error`
- 生产环境默认关闭详细 AI 调试日志
- 不记录 prompt 原文、响应原文、Authorization、apiKey 等敏感内容
- 错误信息统一做脱敏和长度截断

### 2.2 AI 配置导入/导出安全

#### 2.2.1 导出默认脱敏

**问题**：导出全量数据时可能包含完整 AI provider 配置

**解决方案**：
- 导出 AI provider 时默认移除 `apiKey`
- 若未来支持敏感信息导出，必须二次确认并加密文件
- 在导出界面明确标注敏感项处理策略

#### 2.2.2 导入 schema 校验

**问题**：导入逻辑校验较弱，容易写入脏数据或恶意数据

**解决方案**：
- 使用 schema 校验库（如 zod）验证导入文件结构
- 对 provider 配置逐项校验：
  - `type`
  - `name`
  - `baseUrl`
  - `model`
  - `isActive`
- 导入结果返回成功项、失败项和原因，而不是简单整体成功/失败

### 2.3 Provider 架构升级

#### 2.3.1 Provider Registry / Factory

**问题**：当前配置层看似支持多 provider，实际仅真正支持 OpenAI-Compatible

**解决方案**：
- 建立 provider registry / factory map
- 按 `type` 分发不同 provider 实现
- 统一 Provider 接口：
  - `chat()`
  - `testConnection()`
  - `normalizeError()`
  - `supportsFeature()`
- 为后续接入 OpenAI、Anthropic、Gemini、Azure OpenAI、Ollama 预留清晰扩展点

#### 2.3.2 AI 响应结构化

**问题**：当前 chat 仅返回字符串，丢失 usage、finish reason 等信息

**解决方案**：
- Provider 层返回结构化响应：
  - `content`
  - `model`
  - `usage`
  - `finishReason`
  - `requestId`
- Manager、IPC、Preload、Renderer 全链路同步升级
- 为后续成本统计、审计、埋点与 Agent 决策分析提供基础数据

### 2.4 AI 请求稳定性

#### 2.4.1 超时、取消、有限重试

**问题**：AI 请求缺少超时、取消与有限重试能力

**解决方案**：
- 主进程 `fetch` 使用 `AbortController`
- 为请求设置合理 timeout
- 仅对网络抖动、超时等可重试错误执行有限重试
- Store 中维护当前请求控制器，实现“停止生成 / 取消任务”

#### 2.4.2 错误分类与用户提示分层

**问题**：当前错误信息多为原始 message，缺少面向用户的可操作提示

**解决方案**：
- 建立统一错误分类：
  - `auth`
  - `rate_limit`
  - `network`
  - `timeout`
  - `invalid_response`
  - `invalid_config`
- 技术日志与用户提示分层输出
- UI 明确提示排查方向，如检查 API Key、baseUrl、模型名、网络连接等

### 2.5 助手模式上下文管理

#### 2.5.1 统一上下文构建器

**问题**：`sendMessage()` 与 `getContextMessages()` 的上下文选择逻辑存在重复与语义偏差

**解决方案**：
- 抽出统一的 `buildChatContext()`
- 将 system、summary、recent messages、terminal context 的组装逻辑集中管理
- UI 展示与实际发送复用同一套策略，避免行为不一致

#### 2.5.2 从条数裁剪升级到预算裁剪

**问题**：当前按消息条数裁剪上下文，无法有效控制 token 消耗

**解决方案**：
- 改为 token / 字符预算裁剪
- 对超长单条消息分级截断
- 区分普通对话、终端输出、系统提示的预算优先级

#### 2.5.3 自动摘要闭环

**问题**：`keep-summary` 当前只是预留接口，没有真正自动摘要能力

**解决方案**：
- 增加 summarize action
- 当消息超过阈值时自动生成摘要
- 摘要与最近消息分层存储，不无限叠加
- 支持摘要失效、重建与手动刷新

### 2.6 Agent 执行器重构

#### 2.6.1 状态机化执行流程

**问题**：Agent 核心流程主要依赖 React 组件内部 ref、effect、setTimeout 驱动

**解决方案**：
- 将 Agent 核心执行逻辑下沉为独立 service / state machine
- React 组件只负责展示状态与派发事件
- 明确事件模型：
  - `TASK_STARTED`
  - `AI_RESPONDED`
  - `COMMAND_FINISHED`
  - `APPROVAL_GRANTED`
  - `USER_ANSWERED`
  - `TASK_ABORTED`

#### 2.6.2 竞态控制

**问题**：审批继续、ask 回答继续、新任务启动等场景存在重入与竞态风险

**解决方案**：
- 为每轮任务分配 `taskVersion / runId`
- 所有异步结果落地前校验当前版本
- 用显式状态流替代依赖 `setTimeout(100)` 的经验式协调

#### 2.6.3 重复命令硬拦截

**问题**：当前主要依赖提示词让模型避免重复命令，本地缺少硬防线

**解决方案**：
- 本地维护 `executedCommandSet`
- 对完全重复命令直接拦截
- 对高相似命令进行二次确认
- 对允许重复执行的命令建立白名单或策略例外

#### 2.6.4 更可靠的执行完成判断

**问题**：当前依赖启发式规则判断命令输出是否结束，容易误判

**解决方案**：
- 优先在主进程 SSH 执行层提供更可靠的命令生命周期信号
- 区分“执行命令”和“原生终端输入”两类模式
- 对长时间命令、交互式命令、分页输出建立专门策略

#### 2.6.5 终端阻塞识别完善

**问题**：阻塞识别规则覆盖有限，容易卡死或错误推进

**解决方案**：
- 扩充阻塞模式库，如：
  - `[y/n]`
  - `password:`
  - `sudo` 提示
  - `apt/yum` 交互确认
  - 首次 SSH 指纹确认
  - 分页器提示
- 将阻塞状态单独建模为 `waiting_user_input`
- 能安全自动化的场景再考虑补充非交互参数

### 2.7 命令提取与风险分析

#### 2.7.1 修复命令提取准确性

**问题**：列表格式、多词命令、带重定向的合法命令提取不稳定

**解决方案**：
- 重写列表命令提取规则，支持完整命令片段直到注释或说明分隔符
- 为以下场景补测试：
  - bash 代码块
  - 普通代码块
  - 行内代码
  - `- docker ps：查看容器`
  - `- sed -i 's/a/b/g' file：替换内容`
  - 含 `2>&1` 的合法命令
- 将“高风险 shell 特征”与“非法命令”区分处理

#### 2.7.2 风险分析从启发式升级

**问题**：当前风险判断大量依赖 `includes`，误判和漏判都较多

**解决方案**：
- 至少基于命令名、参数、子命令结构做匹配
- 进一步演进为 shell tokenization / parser
- 区分：
  - `rm file`
  - `grep rm logfile`
  - `echo "rm -rf"`
- 风险评分改为加权模型，而不是简单字符串命中

#### 2.7.3 主进程执行前复核

**问题**：风险分析主要放在前端，安全边界偏弱

**解决方案**：
- 将核心风险分析逻辑下沉到主进程或共享安全模块
- 前端只做预判、展示和交互提示
- 真正执行前由主进程统一复核并可拒绝执行

### 2.8 AI 交互体验优化

#### 2.8.1 助手模式支持取消请求

**功能描述**：
- 发送中按钮切换为“停止生成”
- 用户切换 provider、关闭面板或重新提问时，可中断当前请求

#### 2.8.2 Provider 激活改为原子更新

**问题**：切换激活 provider 时对所有 provider 逐个保存，造成多次 IPC 与多次存储写入

**解决方案**：
- 提供单独 `setActiveProvider(providerId)` IPC
- 由主进程一次性更新激活状态

#### 2.8.3 替换原生 `alert / confirm`

**问题**：连接测试、删除 provider 等仍依赖浏览器原生弹框

**解决方案**：
- 统一替换为应用内对话框 / toast / modal
- 桌面端交互体验保持一致

---

## 第三部分：用户体验增强

### 3.1 多会话支持（Tab 页）

**功能描述**：
- 支持同时连接多个 SSH 服务器
- 每个连接在独立的 Tab 页中运行
- Tab 页显示服务器名称和连接状态
- 支持关闭/切换 Tab

**UI 设计**：
```
┌─────────────────────────────────────────────────────────────┐
│  AI SSH Client                    [+] [AI] [⚙]             │
├─────────────────────────────────────────────────────────────┤
│  [我的服务器1 ●] [测试服务器2 ○] [+]                        │
├────────┬────────────────────────────────────┬──────────────┤
│ 连接   │                                    │ AI 助手      │
│        │         终端区域                   │              │
│ ●服务器1│                                    │              │
│ ○服务器2│                                    │              │
│        │                                    │              │
└────────┴────────────────────────────────────┴──────────────┘
```

**实现要点**：
- `terminalOutput` 从 `Record<string, string>` 改为支持多会话
- 每个 Tab 维护独立的 xterm 实例
- 底部状态栏显示当前 Tab 的连接信息

### 3.2 连接分组管理

**功能描述**：
- 支持创建连接分组（如：生产环境、测试环境）
- 分组可以折叠/展开
- 支持拖拽移动连接

**数据结构**：
```typescript
interface ConnectionGroup {
  id: string;
  name: string;
  color?: string;
  connections: string[];
  expanded?: boolean;
}
```

### 3.3 终端功能增强

#### 3.3.1 终端搜索
- 添加 Ctrl+F 快捷键打开搜索框
- 支持正则表达式搜索
- 高亮匹配结果
- 上/下导航匹配项

#### 3.3.2 字体大小调节
- 添加 +/- 快捷键调整字体
- 在设置中添加字体大小选项
- 支持滚轮缩放（按住 Ctrl）

#### 3.3.3 终端全屏
- F11 切换全屏
- 双击标题栏快速全屏

### 3.4 私钥文件选择

**功能描述**：
- 支持点击按钮选择私钥文件
- 读取文件内容自动填充
- 记忆最近使用的私钥路径

### 3.5 命令历史记录

**功能描述**：
- 记录所有通过 AI 执行的命令
- 支持按日期、命令内容搜索
- 支持导出命令历史

**数据结构**：
```typescript
interface CommandHistoryItem {
  id: string;
  command: string;
  timestamp: number;
  connectionId: string;
  connectionName: string;
  executedBy: 'user' | 'ai';
  approved: boolean;
}
```

### 3.6 快速命令/别名

**功能描述**：
- 用户可以定义常用命令的快捷方式
- 在 AI 助手中可以使用别名
- 支持变量替换（如 `$HOSTNAME`）

**数据结构**：
```typescript
interface QuickCommand {
  id: string;
  name: string;
  command: string;
  description?: string;
}
```

### 3.7 浅色主题支持

**功能描述**：
- 添加主题切换（暗色/浅色）
- 记住用户偏好
- 提供系统主题跟随选项

### 3.8 配置导入/导出

**功能描述**：
- 导出所有连接和 AI 配置为 JSON 文件
- 支持导入备份文件
- 支持选择性导入（只导入连接或只导入 AI 配置）
- AI 配置默认脱敏导出，敏感信息单独处理

---

## 第四部分：连接稳定性

### 4.1 SSH Keepalive

**功能描述**：
- 定期发送 SSH keepalive 包
- 防止长时间空闲导致连接断开
- 可配置 keepalive 间隔（默认 60 秒）

**实现方案**：
```typescript
{
  keepaliveInterval: 60000,
  keepaliveCountMax: 3,
}
```

### 4.2 自动重连机制

**功能描述**：
- 连接断开后自动尝试重连
- 指数退避策略（1s, 2s, 4s, 8s...）
- 最多重试 5 次
- 显示重连状态

**状态提示**：
```
● 连接中... (尝试 2/5)
```

### 4.3 连接状态指示器

**功能描述**：
- 实时显示连接状态
- 状态包括：连接中、已连接、断开中、重连中、连接失败
- 不同状态显示不同颜色图标

---

## 第五部分：实现计划

### Phase 1: 安全与基础契约治理（优先最高）
1. API Key 安全存储或最小化明文暴露
2. 导出脱敏、日志脱敏
3. 导入 schema 校验
4. 统一 IPCResult 返回结构
5. 收紧 shared types

### Phase 2: AI 请求稳定性与交互闭环
1. Provider 请求超时与 AbortController
2. 助手模式取消请求
3. Agent 模式中止当前 AI 调用
4. 错误分类与用户提示分层
5. Provider 激活改为原子更新

### Phase 3: AI 核心能力升级
1. Provider registry / factory map
2. AI 响应结构化返回
3. 统一上下文构建器
4. 自动摘要闭环
5. 主进程执行前风险复核

### Phase 4: Agent 执行器重构
1. 下沉 Agent executor 为独立 service / state machine
2. 引入 taskVersion / runId 防竞态
3. 增强重复命令拦截
4. 增强命令完成判断和阻塞识别

### Phase 5: 通用体验增强
1. 多会话 Tab
2. 连接分组
3. 终端搜索 / 字体调节 / 全屏
4. 私钥文件选择器
5. 命令历史、快速命令、主题、导入导出完善

---

## 第六部分：优先级排序

| 优先级 | 功能 | 原因 |
|--------|------|------|
| P0 | API Key 安全存储 / 脱敏 | 直接涉及敏感信息安全 |
| P0 | 导入导出安全与 schema 校验 | 避免密钥泄露和脏数据写入 |
| P0 | IPC 契约统一 | 是后续 AI/设置改造的基础 |
| P0 | SSH Keepalive | 解决现有稳定性问题 |
| P1 | AI 请求超时 / 取消 / 重试 | 解决卡死与交互中断问题 |
| P1 | 主进程执行前风险复核 | 提升命令执行安全边界 |
| P1 | Provider registry + 结构化响应 | 提升可扩展性与可观测性 |
| P1 | 多会话支持 | 核心产品能力 |
| P1 | Agent 状态机化 | 解决竞态和复杂流程失控问题 |
| P1 | 自动重连 | 提升连接稳定性 |
| P2 | 上下文统一构建与自动摘要 | 提升 AI 质量与可控性 |
| P2 | 命令提取与风险分析升级 | 提升准确性 |
| P2 | 连接分组 | 提升管理效率 |
| P2 | 终端搜索 | 提升效率 |
| P2 | 字体调节 | 提升体验 |
| P2 | 错误分类与 UI 提示分层 | 提升可用性 |
| P3 | 私钥选择器 | 提升易用性 |
| P3 | 命令历史 | 提升追溯能力 |
| P3 | 快速命令 | 提升效率 |
| P3 | 替换 alert/confirm | 统一应用体验 |
| P4 | 浅色主题 | 锦上添花 |
| P4 | 导入导出高级能力（选择性导入/加密导出） | 数据安全增强 |

---

## 第七部分：建议新增测试清单

### 7.1 `extract-command.ts`
应覆盖：
- bash 代码块
- 普通代码块
- 行内代码
- `- docker ps：查看容器`
- `- sed -i 's/a/b/g' file：替换内容`
- 含 `2>&1` 的合法命令
- 含恶意命令替换 `$(...)` 的非法输入

### 7.2 `analyze-command-risk.ts`
应覆盖：
- `rm file`
- `grep rm logfile`
- `echo "rm -rf"`
- `sudo systemctl stop nginx`
- `dd if=/dev/zero of=/dev/sda`

### 7.3 `AIManager`
应覆盖：
- 保存 provider
- 激活/停用 provider
- 删除 provider
- provider 初始化失败
- chat provider not found
- 导出脱敏逻辑

### 7.4 Provider 层
应覆盖：
- timeout
- AbortController cancel
- 可重试错误重试
- 错误分类
- 结构化响应解析

### 7.5 `useAIStore`
应覆盖：
- keep-all / keep-recent / keep-summary
- 自动摘要触发
- 取消请求
- 上下文预算裁剪

### 7.6 `AgentExecutor` / Agent Service
应覆盖：
- finish 流程
- ask -> user answer -> continue
- approval -> approve -> continue
- approval -> reject -> finish error
- 重复命令拦截
- 长输出裁剪
- 终端阻塞识别
- taskVersion / runId 防竞态

---

## 第八部分：技术注意事项

1. **向后兼容**：已有配置与连接数据需平滑迁移
2. **错误处理**：新增 AI 与设置链路都需明确失败返回结构
3. **类型安全**：避免新增 `any`，共享结构必须可复用
4. **安全边界**：命令执行最终校验必须落在主进程
5. **性能考虑**：多 Tab、长对话、长终端输出场景要注意内存占用
6. **可观测性**：后续可逐步补充请求成功率、耗时、失败分类、token 使用量等指标

---

## 第九部分：对照 `ai-module-analysis.md` 的完成情况结论

### 已补充到规范中的重点项
- API Key 安全存储与导出脱敏
- 日志脱敏与分级
- 导入 schema 校验
- IPC 契约统一
- 共享类型收紧
- Provider registry / factory
- AI 响应结构化
- AI 请求超时 / 取消 / 有限重试
- 错误分类与用户提示分层
- 上下文统一构建器
- 自动摘要闭环
- Agent 状态机化、竞态控制、重复命令拦截
- 命令提取修复与风险分析升级
- 主进程执行前风险复核
- 替换原生 alert / confirm

### 仍未单独展开成实施细节、但已纳入方向的项
- 运行指标与可观测性建设
- 更强的 shell parser / tokenization 能力
- 更精细的命令策略中心

### 结论
目前原 `optimization-spec.md` 中**相对 `ai-module-analysis.md` 明显缺失的核心 AI 优化项，已经补齐到文档层面**。如果下一步要继续推进，建议不是再补“有没有写到”，而是开始把这些条目拆成：

1. 可执行任务清单
2. 代码改造顺序
3. 验收标准
4. 风险与回滚方案
