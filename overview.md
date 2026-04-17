# AI SSH Client 修改记录

## 2026-03-20 AI 上下文管理机制

### 问题背景
用户反馈 AI 对话轮数越多，响应越慢。这是因为当前实现每次都会把**所有历史消息**都发送给 AI，导致：
- Token 消耗越来越大
- API 响应越来越慢
- 成本增加

### 解决方案
实现智能上下文管理机制，支持多种策略控制发送给 AI 的消息数量。

### 新增功能

#### 1. 三种上下文策略

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| **精简上下文** (默认) | 只保留最近 N 条消息 | 长对话、通用场景 |
| **完整上下文** | 保留所有历史消息 | 需要完整记忆的复杂任务 |
| **摘要模式** | 保留摘要 + 最近消息 | （预留）智能摘要功能 |

#### 2. 保留消息数可调
- 范围：2-20 条（默认 6 条，约 3 轮对话）
- 用户可通过 UI 实时调整
- 调节按钮：`+` / `-`

#### 3. 自动裁剪
- 当消息数量超过限制的 2 倍时自动裁剪
- 保留最新的消息，丢弃旧消息
- 可手动触发"立即裁剪上下文"按钮

#### 4. UI 控制面板
在 AI 助手 Header 新增上下文状态按钮：
- 显示当前消息数量
- 下拉菜单包含：
  - 当前策略状态
  - 策略切换选项
  - 保留消息数调节
  - 立即裁剪按钮

### 代码改动

#### useAIStore.ts 新增
```typescript
// 新增状态
contextStrategy: ContextStrategy;   // 'keep-all' | 'keep-recent' | 'keep-summary'
maxContextMessages: number;         // 默认 6
conversationSummary: string;        // 对话摘要

// 新增方法
setContextStrategy(strategy): void;
setMaxContextMessages(max): void;
trimContext(): void;
updateSummary(summary): void;
getContextMessages(): Message[];   // 获取实际发送给 AI 的消息
```

#### sendMessage 逻辑优化
```typescript
// 优化前：发送所有消息
const allMessages = [
  { role: 'system', ... },
  ...messages,  // 所有历史消息！
  userMessage,
];

// 优化后：智能裁剪
const recentMessages = messages.slice(-(maxContextMessages - 2));
const allMessages = [
  { role: 'system', ... },
  ...recentMessages,
  userMessage,
];
```

### 使用效果
1. **首次对话**：发送 3 条消息（system + 1 user + 1 assistant）
2. **第 10 轮对话**：只发送 7 条消息（system + 6 recent）
3. **Token 消耗**：大幅减少，响应速度提升
4. **用户体验**：可感知的状态提示，随时可调

---

## 2026-03-20 AI 对话模块重构

### 重构背景
用户反馈 AI 问答输出的内容问题很大，需要重新设计 AI 对话模块。

### 重构目标
1. 根据用户输入，查询出 Linux 系统的相关命令
2. 输出气泡内命令后加两个按钮：
   - **粘贴按钮**：把命令粘贴到终端输入栏内
   - **执行按钮**：点击直接在终端内执行该命令

### 新增文件
- `src/renderer/components/AIMessageContent.tsx` - 全新的 AI 消息内容组件

### 核心改进

#### 1. 命令解析逻辑
- 创建专门的 `parseAICommands()` 函数解析 AI 响应
- 支持多种格式的命令识别：
  - `- command: description` 格式
  - `- \`command\`: description` 格式
  - 代码块中的 `$ command` 或 `# command` 格式
- 内置 Linux 常用命令词库（200+ 命令）
- 自动验证命令有效性，过滤纯描述文字

#### 2. 命令卡片组件 (CommandCard)
- 每个命令显示为一个独立的卡片
- 清晰展示命令内容和说明文字
- **风险等级标识**：
  - 低风险（绿色边框）：普通系统操作命令
  - 中风险（黄色边框）：涉及删除或修改的命令
  - 高风险（橙色边框）：危险操作命令
  - 严重风险（红色边框）：可能造成不可逆损坏的命令
- **两个操作按钮**：
  - 粘贴按钮（蓝色）：将命令粘贴到终端输入栏
  - 执行按钮（绿色/橙色/红色）：直接执行命令
  - 高危命令执行按钮有明确颜色区分

#### 3. 粘贴到终端功能
- 点击"粘贴"按钮，命令被写入终端输入栏
- 通过 `window.writeToTerminal()` 全局函数实现
- 粘贴后光标会在终端闪烁，用户可编辑后再执行

#### 4. 执行命令功能
- 点击"执行"按钮，命令直接发送到 SSH 执行
- 高风险命令会触发确认弹窗
- 执行结果在终端中实时显示

#### 5. ChatPanel.tsx 简化
- 移除旧的 `dangerouslySetInnerHTML` + onclick 方式
- 移除 230+ 行的 `parseMarkdown()` 函数
- 移除复杂的 HTML 拼接逻辑
- 使用全新的 React 组件方式实现

### 技术细节

#### AIMessageContent.tsx 主要导出
```tsx
// 解析 AI 响应中的命令
export function parseAICommands(content: string): ParsedCommand[]

// 命令卡片组件
export function CommandCard({ command, description, riskLevel, onPaste, onExecute })

// AI 消息内容组件（主组件）
export function AIMessageContent({ content, onPasteCommand, onExecuteCommand })
```

#### ParsedCommand 接口
```tsx
interface ParsedCommand {
  command: string;          // 命令内容
  description: string;      // 命令说明
  isValid: boolean;         // 是否是有效命令
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
}
```

### 使用示例
用户输入：`如何查看磁盘使用情况？`

AI 返回：
```
- df -h：查看磁盘使用（人类可读格式）
- du -sh *：查看当前目录各文件大小
- lsblk：列出块设备
```

显示效果：
- AI 气泡内显示命令卡片列表
- 每个命令有"粘贴"和"执行"两个按钮
- 用户可选择粘贴到终端编辑，或直接执行

---

## 本次修改 (2026-03-19) 第二版

### 修复的问题

#### 1. 修复自动补全位置
- **问题**：自动补全原本放在 ChatPanel 里，应该放在终端里
- **修复**：
  - 从 `ChatPanel.tsx` 移除了自动补全相关代码
  - 在 `Terminal.tsx` 中重新实现命令自动补全功能
  - 使用 Tab 键触发补全
  - 支持 50+ 常用 Linux 命令
  - 从命令历史和快速命令中匹配

#### 2. 修复设置面板开关按钮漂移
- **问题**：开关按钮点击后状态不变化
- **原因**：`onClick={() => {}}` 是空的
- **修复**：
  - 创建可复用的 `ToggleButton` 组件
  - 正确连接 `onChange` 状态更新
  - 为所有开关添加功能（安全设置、通知设置）

#### 3. 实现 SFTP 后端 IPC 处理器
- **问题**：文件传输报错 "listDirectory is not a function"
- **修复**：
  - 在 `connection-manager.ts` 添加 SFTP 方法：
    - `getSFTP()` - 获取 SFTP 实例
    - `listDirectory()` - 列出远程目录
    - `downloadFile()` - 下载文件
    - `uploadFile()` - 上传文件
  - 在 `ssh-handlers.ts` 添加对应的 IPC 处理器
  - 在 `constants.ts` 添加 SFTP IPC 通道常量
  - 在 `preload.ts` 暴露 SFTP API 给渲染进程

#### 4. 更新类型定义
- 在 `types.ts` 的 `AppSettings` 添加新字段：
  - `approveHighRisk` - 审批高风险命令
  - `approveMediumRisk` - 审批中风险命令
  - `rememberChoice` - 记住本次选择
  - `connectionNotifications` - 连接状态通知
  - `commandNotifications` - 命令执行通知
  - `soundEnabled` - 声音提示
- 新增 `SFTPFileInfo` 接口

### 修改/新增的文件
- `src/renderer/components/ChatPanel.tsx` - 移除自动补全
- `src/renderer/components/Terminal.tsx` - 添加自动补全
- `src/renderer/components/SettingsPanel.tsx` - 修复开关按钮
- `src/main/ssh/connection-manager.ts` - 添加 SFTP 方法
- `src/main/ipc/ssh-handlers.ts` - 添加 SFTP 处理器
- `src/main/preload.ts` - 暴露 SFTP API
- `src/shared/constants.ts` - 添加 SFTP 通道
- `src/shared/types.ts` - 添加新类型

---

## 2026-03-19 第一版

### 重构与功能增强

#### 1. 删除导入导出功能
- 移除了 `showImportExport` 状态和相关函数
- 移除了导入/导出模态框 UI
- 清理了未使用的导入图标

#### 2. 连接管理功能完善
- 连接列表项添加**编辑**和**删除**按钮（hover 时显示）
- 添加删除确认模态框
- 更新 App.tsx 连接下拉菜单 UI

#### 3. 设置页面实现
- 新增 `SettingsPanel.tsx` 组件
- 四个设置标签页：终端、SSH、安全、通知
- 终端设置：字体大小、字体选择
- SSH 设置：Keepalive 间隔、最大失败次数、自动重连
- 安全设置：命令审批选项
- 通知设置：各类通知开关

#### 4. 标签页右键菜单功能完善
新增菜单项：
- 复制连接
- 编辑连接
- 重新连接
- 关闭标签页
- 关闭其他标签页
- 关闭所有标签页

#### 5. 终端体验优化
- **移除底部输入栏**，保留原生 xterm.js 输入体验
- 简化右键菜单（仅保留复制和粘贴）
- 清理未使用的状态和函数

#### 6. 命令审批机制优化
- 更新 `CommandApproval.tsx`
- 添加"记住本次选择"选项
- 记住的选择会保存到 localStorage
- 相同风险等级的后续命令自动应用选择

#### 7. 命令执行状态反馈
- 在 Footer 添加命令执行状态显示
- 支持三种状态：pending（旋转图标）、success（完成图标）、error（错误图标）
- 状态显示命令内容并自动消失

#### 8. 文件传输（SFTP）功能
- 新增 `FileTransfer.tsx` 组件
- 远程目录浏览功能
- 文件/文件夹列表显示（图标、大小、时间）
- 拖拽上传文件
- 点击上传按钮选择文件
- 下载文件功能
- 传输任务进度显示

#### 9. 命令自动补全（已移至终端）
- ~~在 ChatPanel 添加自动补全功能~~
- ~~数据源：命令历史、快速命令、常用 Linux 命令~~
- ~~键盘导航支持（上下箭头、Tab 选择、Esc 关闭）~~
- ~~不同类型用不同颜色标识~~
- **现已移至 Terminal.tsx**

#### 10. 多标签页拖拽排序
- 实现 HTML5 拖拽 API
- 支持拖拽标签页重新排序
- 拖拽时显示视觉反馈

### 修改/新增的文件
- `src/renderer/App.tsx` - 重写
- `src/renderer/components/Terminal.tsx` - 重写
- `src/renderer/components/ChatPanel.tsx` - 更新
- `src/renderer/components/CommandApproval.tsx` - 更新
- `src/renderer/components/SettingsPanel.tsx` - 新增
- `src/renderer/components/FileTransfer.tsx` - 新增

---

## 历史修改

### 2026-03-19 (前期)

### 问题1：测试连接按钮点击后无反应

**原因分析**：
- `testConnection` 函数创建了一个临时 `testProvider`（带有随机ID），然后调用 `aiChat(testProvider.id, ...)`
- 但 `AIManager.chat()` 方法通过 providerId 在 providers Map 中查找
- 临时 provider 从未被保存到 AIManager，所以查找失败，抛出 "Provider not found or not active" 错误

**修复内容**：
1. `src/main/ai/manager.ts` - 添加 `testProvider` 方法，直接创建临时 provider 进行测试
2. `src/shared/constants.ts` - 添加 `AI_TEST_PROVIDER` IPC 通道
3. `src/main/ipc/ai-handlers.ts` - 添加对应的 IPC handler
4. `src/main/preload.ts` - 在本地 IPC_CHANNELS 定义和 API 中添加 `testAIProvider`
5. `src/shared/global.d.ts` - 添加 `testAIProvider` 类型声明
6. `src/renderer/components/ChatPanel.tsx` - 修改 `testConnection` 使用新的 `testAIProvider` 方法

### 问题2：终端右键菜单添加"粘贴到输入栏"功能

**新增内容** (`src/renderer/components/Terminal.tsx`)：
1. 添加输入栏状态：`inputText` 和 `inputRef`
2. 添加 `handlePasteToInput` 函数 - 将剪贴板内容粘贴到输入栏
3. 添加 `handleSendFromInput` 函数 - 从输入栏发送命令到终端
4. 更新右键菜单：
   - "粘贴" → "粘贴到终端"
   - 新增 "粘贴到输入栏" 选项
5. 添加输入栏 UI 组件（显示在终端底部），包含：
   - $ 提示符
   - 文本输入框
   - 清空按钮

### 修改的文件
- `src/main/ai/manager.ts`
- `src/main/ipc/ai-handlers.ts`
- `src/main/preload.ts`
- `src/shared/constants.ts`
- `src/shared/global.d.ts`
- `src/renderer/components/ChatPanel.tsx`
- `src/renderer/components/Terminal.tsx`
