/**
 * 内置离线编程字体按需加载器（零外部 CDN，全部打包为本地 WOFF2 静态资源）。
 * 仅在用户实际选择对应字体时动态加载该字体的 latin-400 / 600 / 700 子集，
 * 避免未选用时增加首屏体积；加载完成后等待 document.fonts 就绪，方便 xterm 重绘。
 */

type FontLoader = () => Promise<unknown>;

const BUNDLED_FONT_LOADERS: Array<{ family: string; pattern: RegExp; load: FontLoader }> = [
  {
    family: 'Cascadia Code',
    pattern: /cascadia\s+code/i,
    load: () => Promise.all([
      import('@fontsource/cascadia-code/latin-400.css'),
      import('@fontsource/cascadia-code/latin-600.css'),
      import('@fontsource/cascadia-code/latin-700.css'),
    ]),
  },
  {
    family: 'Fira Code',
    pattern: /fira\s+code/i,
    load: () => Promise.all([
      import('@fontsource/fira-code/latin-400.css'),
      import('@fontsource/fira-code/latin-600.css'),
      import('@fontsource/fira-code/latin-700.css'),
    ]),
  },
  {
    family: 'JetBrains Mono',
    pattern: /jetbrains\s+mono/i,
    load: () => Promise.all([
      import('@fontsource/jetbrains-mono/latin-400.css'),
      import('@fontsource/jetbrains-mono/latin-600.css'),
      import('@fontsource/jetbrains-mono/latin-700.css'),
    ]),
  },
  {
    family: 'Source Code Pro',
    pattern: /source\s+code\s+pro/i,
    load: () => Promise.all([
      import('@fontsource/source-code-pro/latin-400.css'),
      import('@fontsource/source-code-pro/latin-600.css'),
      import('@fontsource/source-code-pro/latin-700.css'),
    ]),
  },
];

const loadedFonts = new Map<string, Promise<void>>();

/**
 * 若给定字体栈命中内置 Web 字体，则按需加载其 WOFF2 文件并等待字体face 就绪。
 * 重复调用复用同一 Promise，在无 document.fonts 的测试环境中静默返回。
 */
export function ensureWebFontLoaded(fontFamily?: string): Promise<void> {
  if (!fontFamily) return Promise.resolve();
  const matched = BUNDLED_FONT_LOADERS.find((entry) => entry.pattern.test(fontFamily));
  if (!matched) return Promise.resolve();

  const existing = loadedFonts.get(matched.family);
  if (existing) return existing;

  const task = (async () => {
    try {
      await matched.load();
      if (typeof document !== 'undefined' && document.fonts && typeof document.fonts.load === 'function') {
        await Promise.allSettled([
          document.fonts.load(`400 14px "${matched.family}"`),
          document.fonts.load(`600 14px "${matched.family}"`),
        ]);
      }
    } catch {
      // 字体加载失败时保留系统回退字体，不中断渲染
    }
  })();

  loadedFonts.set(matched.family, task);
  return task;
}
