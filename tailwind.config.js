/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
        // 暗色主题
        dark: {
          bg: {
            primary: '#020617',
            secondary: '#0f172a',
            tertiary: '#1e293b',
            hover: '#334155',
          },
          border: '#475569',
          text: {
            primary: '#f8fafc',
            secondary: '#cbd5e1',
            muted: '#94a3b8',
          },
        },
        // 浅色主题
        light: {
          bg: {
            primary: '#ffffff',
            secondary: '#f8fafc',
            tertiary: '#f1f5f9',
            hover: '#e2e8f0',
          },
          border: '#cbd5e1',
          text: {
            primary: '#0f172a',
            secondary: '#334155',
            muted: '#64748b',
          },
        },
        accent: 'var(--accent-primary)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
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
    function({ addUtilities }) {
      // 自定义滚动条样式
      const scrollbarUtilities = {
        '.scrollbar-thin': {
          scrollbarWidth: 'thin',
          '&::-webkit-scrollbar': {
            width: '6px',
            height: '6px',
          },
        },
        '.scrollbar-thumb-slate-300': {
          '&::-webkit-scrollbar-thumb': {
            backgroundColor: '#cbd5e1',
            borderRadius: '3px',
          },
        },
        '.dark\\:scrollbar-thumb-slate-600': {
          '.dark &::-webkit-scrollbar-thumb': {
            backgroundColor: '#475569',
          },
        },
        '.scrollbar-track-transparent': {
          '&::-webkit-scrollbar-track': {
            backgroundColor: 'transparent',
          },
        },
        '.hover\\:scrollbar-thumb-slate-400': {
          '&::-webkit-scrollbar-thumb:hover': {
            backgroundColor: '#94a3b8',
          },
        },
        '.dark\\:hover\\:scrollbar-thumb-slate-500': {
          '.dark &:hover::-webkit-scrollbar-thumb, .dark &::-webkit-scrollbar-thumb:hover': {
            backgroundColor: '#64748b',
          },
        },
      };
      addUtilities(scrollbarUtilities);
    },
  ],
}
