import { defineConfig } from 'vitest/config';

// Vitest 配置：与 Vite 构建配置分离，仅用于单元测试。
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.{ts,cts,mts}'],
    coverage: {
      provider: 'v8',
      include: [
        'src/renderer/session/terminal/paste-safety.ts',
        'src/renderer/session/terminal/terminal-settings.ts',
        'src/renderer/session/terminal/shell-integration.ts',
        'src/renderer/history/command-history-index.ts',
        'server/sentinel.cjs',
        'server/sftp-items.cjs',
        'server/sftp-upload.cjs',
        'server/sftp-transfer.cjs',
      ],
    },
  },
});
