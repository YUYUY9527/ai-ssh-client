/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // 语义色板：所有颜色都指向 index.css 里的设计令牌（唯一来源）。
      // 组件只允许使用这些语义类；禁止再写 Tailwind 数字调色板（slate-500 / red-400 …），
      // 由 scripts/lib/ui-design-system-check.cjs 硬失败把关。
      colors: {
        transparent: 'transparent',
        current: 'currentColor',
        // 表面（背景层级）
        app: 'var(--bg-primary)',
        surface: {
          DEFAULT: 'var(--bg-secondary)',
          raised: 'var(--bg-tertiary)',
          hover: 'var(--bg-hover)',
          sunken: 'var(--bg-sunken)',
          elevated: 'var(--bg-elevated)',
          inverse: 'var(--bg-inverse)',
        },
        // 文本层级
        fg: {
          DEFAULT: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
          subtle: 'var(--text-subtle)',
          faint: 'var(--text-faint)',
          inverse: 'var(--text-inverse)',
        },
        // 边框层级
        line: {
          DEFAULT: 'var(--border-color)',
          subtle: 'var(--border-subtle)',
          strong: 'var(--border-strong)',
        },
        // 品牌强调色
        accent: {
          DEFAULT: 'var(--accent-primary)',
          hover: 'var(--accent-hover)',
          muted: 'var(--accent-muted)',
          strong: 'var(--accent-strong)',
          'strong-muted': 'color-mix(in srgb, var(--accent-strong) 15%, transparent)',
          alt: 'var(--accent-alt)',
          'alt-muted': 'color-mix(in srgb, var(--accent-alt) 15%, transparent)',
          fg: '#ffffff',
        },
        // 状态色
        success: { DEFAULT: 'var(--success)', muted: 'var(--success-muted)', fg: 'var(--success-fg)' },
        warning: { DEFAULT: 'var(--warning)', muted: 'var(--warning-muted)', fg: 'var(--warning-fg)' },
        danger: { DEFAULT: 'var(--danger)', muted: 'var(--danger-muted)', fg: 'var(--danger-fg)' },
        info: { DEFAULT: 'var(--info)', muted: 'var(--info-muted)', fg: 'var(--info-fg)' },
        // 遮罩
        overlay: 'var(--overlay)',
      },
      // 层级令牌：禁止裸写 z-50 / z-[9999]，统一用命名层
      zIndex: {
        base: '0',
        raised: '10',
        dropdown: '50',
        popover: '60',
        toast: '70',
        header: '80',
        overlay: '90',
        modal: '9999',
        tooltip: '10000',
      },
      fontFamily: {
        sans: ['Geist', 'IBM Plex Sans', 'Segoe UI Variable', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Source Code Pro', 'Consolas', 'monospace'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
      transitionDuration: {
        chrome: '180ms',
      },
      transitionTimingFunction: {
        chrome: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
  ],
}
