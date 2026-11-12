# 设计令牌（Design Tokens）

本项目渲染层的颜色、圆角、动效、层级全部通过**一层设计令牌**统一管理，唯一来源是
`src/renderer/index.css` 里的 CSS 变量；`tailwind.config.js` 只把这些变量映射成语义类名。
组件里**只允许**使用语义类（如 `bg-surface`、`text-fg-muted`、`border-line`），
禁止再写 Tailwind 数字调色板（`slate-500`、`red-400` …）、裸 `#hex`、裸 `z-50`。

护栏：`scripts/lib/ui-design-system-check.cjs` 的 `validateUiDesignSystem()`，
由 `test/ui-design-system.test.ts` 调用，`npm run test:ui` 可单独跑。命中即**硬失败**（构建/测试失败）。

---

## 1. 令牌清单（`:root, .dark` 与 `.light` 成对定义）

| 令牌 | 用途 | dark | light |
| --- | --- | --- | --- |
| `--bg-primary` | 应用底色 | `#080c10` | `#f3f1ea` |
| `--bg-secondary` | 卡片/主表面 | `#0f151b` | `#fcfbf6` |
| `--bg-tertiary` | 抬升表面 | `#172027` | `#ebe7db` |
| `--bg-hover` | 悬停表面 | `#26323a` | `#ded8c9` |
| `--bg-elevated` | 浮层/弹层 | `#121a21` | `#ffffff` |
| `--bg-sunken` | 内凹/代码底 | `#05080b` | `#ece9df` |
| `--bg-inverse` | 反色块 | `#e7ece7` | `#1f2a27` |
| `--border-color` | 默认边框 | `#31404a` | `#c8c0af` |
| `--border-subtle` | 弱边框（55%） | `color-mix(...)` | `color-mix(...)` |
| `--border-strong` | 强边框 | `#3d4d58` | `#b3a890` |
| `--text-primary` | 主文本 | `#f5f7f2` | `#18211f` |
| `--text-secondary` | 次文本 | `#c9d3cc` | `#43504a` |
| `--text-muted` | 弱文本 | `#8a9992` | `#6f7b74` |
| `--text-subtle` | 更弱文本 | `#6b7a73` | `#8a948d` |
| `--text-faint` | 占位/极弱 | `#55625c` | `#9aa39d` |
| `--text-inverse` | 反色文本 | `#1f2a27` | `#f5f7f2` |
| `--accent-primary` | 品牌主色 | `#14b8a6` | `#0f766e` |
| `--accent-hover` | 主色悬停 | `#2dd4bf` | `#0d9488` |
| `--accent-muted` | 主色淡底 | 16% 透明 | 12% 透明 |
| `--accent-strong` | 主色强调 | `#f97316` | `#c2410c` |
| `--accent-alt` | 次强调（violet） | `#a78bfa` | `#7c3aed` |
| `--success` / `-muted` / `-fg` | 成功 | `#22c55e` / 14% / `#86efac` | `#16a34a` / 12% / `#15803d` |
| `--warning` / `-muted` / `-fg` | 警告 | `#eab308` / 14% / `#fde047` | `#ca8a04` / 12% / `#a16207` |
| `--danger` / `-muted` / `-fg` | 危险 | `#ef4444` / 14% / `#fca5a5` | `#dc2626` / 12% / `#b91c1c` |
| `--info` / `-muted` / `-fg` | 信息 | `#3b82f6` / 14% / `#93c5fd` | `#2563eb` / 12% / `#1d4ed8` |
| `--overlay` | 遮罩层 | `rgba(3,6,8,.62)` | `rgba(20,18,12,.42)` |
| `--radius-sm/md/lg` | 圆角 6/8/12 | — | — |

> 具体数值以 `src/renderer/index.css` 为准；上表仅列层级与语义。

## 2. 语义类对照（Tailwind）

- 背景：`bg-app` / `bg-surface` / `bg-surface-raised` / `bg-surface-hover` / `bg-surface-sunken` / `bg-surface-elevated` / `bg-surface-inverse` / `bg-overlay`
- 文本：`text-fg` / `text-fg-secondary` / `text-fg-muted` / `text-fg-subtle` / `text-fg-faint` / `text-fg-inverse`
- 边框：`border-line` / `border-line-subtle` / `border-line-strong`
- 强调：`accent` / `accent-hover` / `accent-muted` / `accent-strong` / `accent-strong-muted` / `accent-alt` / `accent-alt-muted` / `accent-fg`（如 `bg-accent`、`text-accent-hover`）
- 状态：`{success|warning|danger|info}` 及 `-muted` / `-fg`
- 层级：`z-base` `z-raised` `z-dropdown` `z-popover` `z-toast` `z-header` `z-overlay` `z-modal` `z-tooltip`

颜色令牌本身已按主题切换，**不要再写 `dark:` 前缀去换色**；只有少数确实需要分主题微调的地方才用 `dark:`。

## 3. 迁移映射（旧的数字调色板 → 语义类）

| 旧写法 | 新写法 |
| --- | --- |
| `text-slate-900 dark:text-white` | `text-fg` |
| `text-slate-600 dark:text-slate-300` | `text-fg-secondary` |
| `text-slate-500 dark:text-slate-400` | `text-fg-muted` |
| `text-slate-400 dark:text-slate-500` | `text-fg-subtle` |
| `text-slate-400`（占位） | `text-fg-faint` |
| `bg-slate-800/900`（暗底） | `bg-surface` / `bg-surface-raised` |
| `hover:bg-slate-*` | `hover:bg-surface-hover` |
| `border-slate-*` | `border-line` / `border-line-subtle` / `border-line-strong` |
| `text-teal-*` | `text-accent`（hover 用 `text-accent-hover`，淡底 `bg-accent-muted`） |
| `text-violet-*` | `text-accent-alt` / `bg-accent-alt-muted` |
| `text-red-*` | `text-danger`（淡底 `bg-danger-muted`） |
| `text-green-*/emerald-*` | `text-success` |
| `text-amber-*/yellow-*` | `text-warning` |
| `text-sky-*/blue-*` | `text-info` |
| `z-50` / `z-[60]` / `z-[80]` / `z-[90]` / `z-[9999]` | `z-dropdown` / `z-popover` / `z-header` / `z-overlay` / `z-modal` |

## 4. 硬失败规则（护栏检查）

扫描 `src/renderer/**/*.tsx`：

1. 出现 `(slate|zinc|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}` → 失败。
2. 出现裸十六进制 `#rgb/#rrggbb(aa)` → 失败（**白名单整文件跳过**：`src/renderer/session/terminal/terminal-theme.ts`、`src/renderer/components/AppIcon.tsx`、`src/renderer/components/FileTypeIcon.tsx`、`src/renderer/components/QuickCommandsPanel.tsx` —— 这些是终端 ANSI 主题 / 品牌 SVG / 数据色盘，属于合法资产）。
3. 出现裸 `z-<数字>` 或 `z-[<数字>]` → 失败，必须用命名层级。

同时校验：`index.css` 的 dark/light 两块色令牌齐全成对；`tailwind.config.js` 不再含已废弃的 `primary/dark/light` 色板，且包含 `surface/fg/line/accent/danger/zIndex` 等语义分组。

## 5. 新增颜色的流程

1. 先在 `index.css` 的 `:root,.dark` **和** `.light` 两块同时加一对 CSS 变量（保证明暗都可用）；
2. 在 `tailwind.config.js` 的 `theme.extend.colors` 里映射为语义名；
3. 在护栏的 `COLOR_TOKENS` 列表登记；
4. 组件里只用语义类。
