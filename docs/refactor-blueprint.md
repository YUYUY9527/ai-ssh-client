# AI SSH Client 重构蓝图

## 1. 文档目的

本文档用于指导 AI SSH Client 的结构性重构，目标不是继续堆叠功能，而是在保留现有可用能力的前提下，把项目收敛成一个长期可维护的多会话 SSH/SFTP 工作台。

本次重构基于当前项目现状和以下已确认的产品约束：

- 产品主线是 **原生 SSH 和文件传输**
- AI 能力继续保留，但作为 **辅助层**
- AI 接口只要求 **兼容 OpenAI 接口**
- 命令执行策略为 **低风险自动执行，高风险确认**
- 典型使用场景为 **长期打开 5-10 个会话**
- SFTP 需要从弹窗切换为 **绑定当前会话的侧栏工作区**
- 命令历史按 **host -> username -> cwd** 分层
- 最近会话的终端输出需要 **有限持久化**
- 后续允许补充 **SSH 主机指纹校验**

---

## 2. 重构目标

### 2.1 产品目标

将项目重新定义为：

`多会话 SSH/SFTP 客户端 + AI 辅助执行层`

能力优先级如下：

1. 多会话 SSH 稳定性
2. 会话绑定的 SFTP 工作区
3. 会话恢复与最近输出持久化
4. 分层命令历史
5. AI 助手、小机器人、命令建议与风险分析
6. Agent 自动执行能力

### 2.2 工程目标

1. 降低页面级大组件复杂度
2. 统一运行时状态模型
3. 统一 SSH 事件流来源
4. 收紧前后端领域边界
5. 为后续功能演进预留稳定扩展点

### 2.3 非目标

以下内容不作为本轮重构目标：

- 重写 UI 风格系统
- 接入多种原生 AI 厂商协议
- 实现完整的 shell parser
- 对历史功能做大范围行为改造
- 同时推进大规模新功能开发

---

## 3. 当前问题摘要

### 3.1 前端主编排层过重

当前 [src/renderer/App.tsx](../src/renderer/App.tsx) 同时承担：

- 连接管理
- 标签页管理
- 重连逻辑
- SSH 事件监听
- 弹窗编排
- SFTP 打开逻辑
- toast 管理
- 设置入口
- 命令审批
- 小机器人入口

这导致：

- 修改一个局部功能时容易波及整页
- 很难建立清晰的测试边界
- 会话数提升后调试成本快速上升

### 3.2 终端组件职责过载

当前 [src/renderer/components/Terminal.tsx](../src/renderer/components/Terminal.tsx) 同时负责：

- xterm 实例生命周期
- SSH 输入输出桥接
- 输入跟踪
- cwd 推断
- 命令历史写入
- 搜索
- 主题切换
- 右键菜单
- 剪贴板处理
- 写入 AI / 粘贴到终端

这已经不是单纯的 UI 组件，而是一个混合运行时。

### 3.3 运行时模型没有从 connection 升级到 session

当前 store 命名和状态结构仍以 `connection` 为核心，但运行时真正稳定的核心对象应该是 `session`：

- `connection` 表示保存下来的连接配置
- `session` 表示一次已打开、可恢复、可追踪的运行时会话

如果不做这一步，后续的多会话恢复、SFTP 绑定、历史分层、scrollback 持久化都会继续拼凑在旧模型上。

### 3.4 SSH 事件流存在双消费倾向

当前 `App` 和 `Terminal` 都在消费 SSH 相关事件，容易带来以下问题：

- 输出显示与缓存状态不一致
- 重连恢复时行为分裂
- 后续难以定位“是谁在真正拥有会话输出”

### 3.5 AI 能力位置偏重

项目最初定位偏向“AI 操控 SSH”，但真实使用情况已经表明：

- AI 不是主工作流
- SSH 和 SFTP 才是高频能力

因此 AI 应被保留，但不应继续主导整体架构。

---

## 4. 目标架构

### 4.1 产品层次

重构后产品结构应收敛为：

```text
AI SSH Client
├── Workspace（工作台）
│   ├── Session Tabs（会话标签）
│   ├── Active Session View（当前会话）
│   │   ├── Terminal View（终端）
│   │   └── SFTP Sidebar（文件侧栏）
│   └── Footer / Status（状态栏）
├── Assistant（小机器人）
│   ├── AI Chat
│   ├── Command Suggestion
│   └── Risk Approval
└── Settings（设置）
```

### 4.2 领域划分

前端领域建议收敛为：

```text
src/renderer/
├── app/            # 应用壳层和布局编排
├── workspace/      # 会话标签、布局、活动工作区
├── session/        # SSH 会话运行时、输出、恢复、重连
├── transfer/       # SFTP 浏览和传输任务
├── history/        # 命令历史索引与查询
├── assistant/      # AI 小机器人、命令建议、审批
├── settings/       # 设置面板和配置项
├── shared-ui/      # 可复用通用 UI
└── lib/            # Tauri bridge、基础工具
```

### 4.3 核心对象模型

#### Connection

连接配置对象，负责持久化存储。

```ts
interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'private-key';
}
```

#### Session

运行时会话对象，负责工作台行为。

```ts
interface Session {
  id: string;
  connectionId: string;
  title: string;
  state: 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';
  isPinned?: boolean;
  scrollbackKey?: string;
  reconnectAttempts: number;
  lastActiveAt: number;
}
```

#### SessionScrollbackSnapshot

最近会话终端输出快照。

```ts
interface SessionScrollbackSnapshot {
  sessionId: string;
  connectionId: string;
  updatedAt: number;
  cwd?: string;
  content: string;
}
```

#### CommandHistoryIndex

命令历史分层索引。

```ts
interface CommandHistoryIndex {
  host: string;
  username: string;
  cwd: string;
  commands: CommandHistoryItem[];
}
```

---

## 5. 模块边界设计

### 5.1 App 层

目标是把 [src/renderer/App.tsx](../src/renderer/App.tsx) 拆成稳定的壳层模块。

建议拆分为：

```text
src/renderer/app/
├── AppShell.tsx
├── WorkspaceHeader.tsx
├── AppFooter.tsx
├── ModalHost.tsx
└── ToastHost.tsx
```

职责：

- `AppShell`：拼装顶层布局
- `WorkspaceHeader`：连接入口、主题、设置入口
- `AppFooter`：当前会话状态、执行状态
- `ModalHost`：集中管理设置、编辑连接、审批等弹层
- `ToastHost`：集中管理通知

约束：

- `AppShell` 不直接处理 SSH 原始输出
- `AppShell` 不直接维护终端内部状态
- 会话细节进入 `workspace/session` 域

### 5.2 Workspace 层

新增：

```text
src/renderer/workspace/
├── WorkspaceTabs.tsx
├── SessionWorkspace.tsx
├── WorkspaceLayout.tsx
└── useWorkspaceStore.ts
```

职责：

- 当前活动会话 ID
- 标签页排序与关闭
- SFTP 侧栏开关状态
- 小机器人展开状态
- 工作区布局状态

### 5.3 Session 层

新增：

```text
src/renderer/session/
├── SessionTerminal.tsx
├── useSessionStore.ts
├── useSessionBridge.ts
├── useSessionRecovery.ts
├── session-scrollback.ts
└── session-types.ts
```

职责：

- 运行时会话注册
- SSH 会话状态更新
- 终端输出缓存与恢复
- 自动重连
- 最近会话持久化

关键约束：

- 所有 SSH 原始事件只允许在 `SessionBridge` 一处消费
- 其他组件只读 store，不直接监听底层事件

### 5.4 Terminal 层

从旧 `Terminal.tsx` 中拆出以下模块：

```text
src/renderer/session/terminal/
├── TerminalView.tsx
├── TerminalToolbar.tsx
├── TerminalContextMenu.tsx
├── useXtermInstance.ts
├── useTerminalInputTracking.ts
├── useTerminalSearch.ts
└── useTerminalClipboard.ts
```

职责：

- `useXtermInstance`：xterm 生命周期、fit、theme 绑定
- `useTerminalInputTracking`：命令输入、cwd 推断、历史记录
- `useTerminalSearch`：搜索功能
- `useTerminalClipboard`：复制粘贴和右键菜单
- `TerminalView`：只负责渲染和编排

约束：

- `TerminalView` 不关心连接列表
- `TerminalView` 不关心设置面板
- `TerminalView` 不关心全局弹窗

### 5.5 Transfer 层

把 SFTP 从弹窗切换为会话侧栏工作区。

建议新增：

```text
src/renderer/transfer/
├── SftpSidebar.tsx
├── SftpBrowser.tsx
├── TransferTaskList.tsx
├── useTransferStore.ts
└── transfer-types.ts
```

职责：

- 绑定当前活动会话
- 浏览远端目录
- 上传下载任务管理
- 显示会话级传输状态

约束：

- `SftpSidebar` 不再以 modal 形式存在
- 同一时刻只展示当前活动会话的 SFTP 工作区

### 5.6 History 层

新增：

```text
src/renderer/history/
├── useCommandHistoryStore.ts
├── command-history-index.ts
└── CommandHistoryPanel.tsx
```

职责：

- 把历史记录组织为 `host -> username -> cwd`
- 为搜索、补全和快速复用提供统一入口

### 5.7 Assistant 层

小机器人保留现有产品形态，但职责下沉。

建议收敛为：

```text
src/renderer/assistant/
├── AssistantHost.tsx
├── AssistantStore.ts
├── RiskApprovalService.ts
└── command-policy.ts
```

职责：

- AI 对话
- 建议命令展示
- 风险分析结果显示
- 执行审批

约束：

- AI 不负责会话主编排
- AI 只消费会话上下文，不拥有会话生命周期

---

## 6. 后端调整方向

### 6.1 Tauri Bridge 分层

当前 [src/renderer/lib/native.ts](../src/renderer/lib/native.ts) 已经承担了桥接能力，但后续应按领域拆读。

建议逻辑分组为：

- `native/ssh.ts`
- `native/sftp.ts`
- `native/history.ts`
- `native/assistant.ts`
- `native/settings.ts`

这样可以避免单文件继续膨胀，同时让调用方只依赖所需域。

### 6.2 SSH 服务侧目标

当前 [src-tauri/src/services/ssh_service.rs](../src-tauri/src/services/ssh_service.rs) 的整体方向是对的，本轮不建议重写，而是做边界增强。

建议新增能力预留：

1. 主机指纹校验模型
2. 会话恢复所需的最小元数据
3. 更清晰的会话关闭原因
4. 为未来命令执行生命周期增强预留事件结构

### 6.3 AI 服务侧目标

AI 服务继续保留，但要收缩定义：

- 面向 OpenAI-compatible
- 特例保留 Ollama
- 不再在产品和代码命名上暗示“原生支持所有厂商”

当前 [src-tauri/src/services/ai_service.rs](../src-tauri/src/services/ai_service.rs) 可继续沿用，但后续建议把 provider 命名和 UI 表述都同步收敛。

---

## 7. 数据与持久化策略

### 7.1 最近会话 scrollback 持久化

目标：

- 只持久化最近使用的若干会话输出
- 不做无限制日志归档

建议策略：

- 仅保留最近 `5-10` 个会话的 scrollback
- 每个会话输出限制 `100KB - 300KB`
- 应用退出或会话切换时节流写入
- 重启后恢复最近会话显示内容，但不伪造“仍在线”的连接状态

建议新增配置：

```ts
interface SessionPersistenceSettings {
  maxPersistedSessions: number;
  maxScrollbackBytesPerSession: number;
}
```

### 7.2 命令历史分层

命令历史需要长期保存，但索引方式要为真实使用场景服务。

推荐结构：

```text
host
└── username
    └── cwd
        └── commands[]
```

收益：

- 更适合多机管理
- 更适合根据当前目录推荐命令
- 可为自动补全和最近命令复用提供更准确数据

### 7.3 主机指纹校验预留

建议在连接存储模型中预留：

```ts
interface HostTrustRecord {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  trustedAt: number;
}
```

重构阶段不要求立即做完整交互，但数据模型和后端接口要预留位置。

---

## 8. 分阶段实施方案

### Phase 1：壳层拆分，不改行为

目标：

- 拆 [App.tsx](../src/renderer/App.tsx)
- 保持现有行为不变

任务：

1. 抽出 `AppShell`
2. 抽出 `WorkspaceHeader`
3. 抽出 `AppFooter`
4. 抽出 `ModalHost`
5. 抽出 `ToastHost`

验收标准：

- UI 行为无明显变化
- 连接、审批、设置、文件传输入口仍可用
- `App.tsx` 只保留顶层装配逻辑

### Phase 2：终端拆分，不改行为

目标：

- 拆 [Terminal.tsx](../src/renderer/components/Terminal.tsx)
- 保持现有输入输出和快捷键行为

任务：

1. 抽出 `useXtermInstance`
2. 抽出 `useTerminalInputTracking`
3. 抽出 `useTerminalSearch`
4. 抽出 `TerminalToolbar`
5. 抽出 `TerminalContextMenu`

验收标准：

- 终端显示和输入行为一致
- 搜索、字体、粘贴、右键菜单仍可用
- 命令历史仍正常记录

### Phase 3：引入 session 领域模型

目标：

- 从 `connection store` 升级到 `session store`

任务：

1. 新建 `useSessionStore`
2. 定义运行时 `Session` 对象
3. 统一活动会话和标签页状态
4. 把 SSH 运行时状态迁移到 `session` 域

验收标准：

- `connection` 只代表配置
- `session` 代表运行时
- 多会话状态来源统一

### Phase 4：统一 SSH 事件流

目标：

- 所有 SSH 原始事件由单一桥接层消费

任务：

1. 建立 `useSessionBridge`
2. 把 `ssh-data / ssh-error / ssh-close` 的监听收敛到桥接层
3. 组件只通过 store 读取数据

验收标准：

- 不再存在多个组件直接抢占 SSH 原始事件
- 输出、状态、关闭事件在 UI 上表现一致

### Phase 5：SFTP 改为会话侧栏

目标：

- 用侧栏替代当前弹窗

任务：

1. 新建 `SftpSidebar`
2. 当前活动会话与侧栏绑定
3. 抽离现有 `FileTransfer` 内可复用逻辑
4. 建立传输任务列表

验收标准：

- 切换会话时 SFTP 内容跟随变化
- 不再依赖 modal 打开文件传输
- 上传下载任务仍正常工作

### Phase 6：最近会话输出持久化

目标：

- 重启应用后恢复最近会话输出视图

任务：

1. 新建 scrollback snapshot 存储
2. 对写入做节流和上限控制
3. 恢复最近会话内容
4. 将“已恢复输出”和“已恢复连接”区分开

验收标准：

- 应用重启后可看到最近会话输出
- 不会错误显示为“已连接”
- 不会导致存储无限增长

### Phase 7：命令历史分层与主机指纹预留

目标：

- 完成历史数据重组
- 为主机信任模型预留后端支持

任务：

1. 历史索引按 `host -> username -> cwd`
2. 更新相关查询和展示逻辑
3. 设计主机指纹存储结构
4. Rust 侧预留信任查询接口

验收标准：

- 历史查询结果可按层级筛选
- 新连接模型能容纳主机信任信息

---

## 9. 文件级迁移建议

### 9.1 建议保留并逐步下沉

- [src/renderer/store/useConnectionStore.ts](../src/renderer/store/useConnectionStore.ts)
- [src/renderer/store/useAIStore.ts](../src/renderer/store/useAIStore.ts)
- [src/renderer/components/FileTransfer.tsx](../src/renderer/components/FileTransfer.tsx)
- [src/renderer/components/CommandHistoryPanel.tsx](../src/renderer/components/CommandHistoryPanel.tsx)

这些文件不建议一次性删除，应先提取可复用逻辑，再迁移职责。

### 9.2 建议最终退场或瘦身

- [src/renderer/App.tsx](../src/renderer/App.tsx)
- [src/renderer/components/Terminal.tsx](../src/renderer/components/Terminal.tsx)

它们最终应退化为轻量壳层，而不是继续承载主要业务逻辑。

### 9.3 建议新增目录

```text
src/renderer/
├── app/
├── workspace/
├── session/
├── transfer/
├── history/
└── assistant/
```

---

## 10. 风险与控制

### 10.1 主要风险

1. 重构期间引入会话状态回归
2. SSH 输出消费迁移时出现重复或丢失
3. Terminal 拆分后快捷键或输入跟踪失效
4. SFTP modal 改侧栏后布局回归
5. 最近会话持久化引入性能和存储膨胀

### 10.2 控制策略

1. 每个 Phase 都要求“不改行为优先”
2. 每一步拆分先做搬运，再做职责收口
3. 先引入新模块，再迁移旧模块调用
4. scrollback 持久化必须加上限
5. 所有会话恢复逻辑都要明确区分“已恢复视图”和“已恢复连接”

### 10.3 回滚策略

每个 Phase 都应保持以下特征：

- 独立提交
- 单独可回滚
- 不与其他大功能变更混合

---

## 11. 验收清单

### 11.1 结构验收

- `App.tsx` 不再是主业务编排中心
- `Terminal.tsx` 不再承担多类运行时职责
- 已建立独立 `session` 域
- 已建立独立 `transfer` 域

### 11.2 行为验收

- 5-10 个会话切换稳定
- 重连流程清晰
- SFTP 跟随活动会话切换
- 小机器人仍可用
- 命令审批逻辑保持原有策略

### 11.3 数据验收

- 命令历史按层级组织
- 最近会话输出可恢复
- 会话输出持久化有体积上限
- 主机指纹信任模型已有预留结构

---

## 12. 推荐执行顺序

建议严格按以下顺序推进：

1. 拆 `App.tsx`
2. 拆 `Terminal.tsx`
3. 建立 `session` 域模型
4. 统一 SSH 事件流
5. 把 SFTP 改成会话侧栏
6. 做最近会话输出持久化
7. 重组命令历史
8. 预留主机指纹校验

不建议把这些步骤并行推进，否则很容易把“结构重构”和“行为变更”混在一起，导致回归难查。

---

## 13. 最终结论

这次重构不是为了把代码“写得更漂亮”，而是为了匹配项目已经确认的真实使用方式：

- SSH 是主线
- SFTP 是核心配套
- 多会话是第一约束
- AI 是辅助层
- 可维护性比继续加功能更重要

只要继续让 `App.tsx` 和 `Terminal.tsx` 承担当前这类混合职责，项目复杂度就会继续按页面膨胀，而不是按领域收敛。

因此，本轮最重要的不是新增能力，而是把系统重新组织成：

`以 session 为中心的工作台架构`

这会决定后续每一项能力是越做越稳，还是越做越难维护。
