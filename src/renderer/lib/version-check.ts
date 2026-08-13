/**
 * 前端版本自检：定期对比服务端 index.html 引用的主 chunk hash。
 *
 * 解决"部署更新后浏览器仍跑旧代码、需手动 Ctrl+Shift+R"的问题：
 * 页面加载后 index.html 不会自动刷新，即使服务端已部署新版，
 * 已打开的页面仍运行旧 JS。此模块周期性拉取最新入口 HTML，
 * 发现主 chunk hash 变化即通知 UI 提示并自动刷新。
 *
 * 仅 web 模式启用（Tauri/Electron 桌面端为独立打包，无此问题）。
 */

const CHECK_INTERVAL_MS = 60_000;

/** 从当前页面提取已加载的主 chunk hash（assets/index-<hash>.js）。 */
function currentEntryHash(): string | null {
  for (const script of document.querySelectorAll('script[src]')) {
    const src = script.getAttribute('src') || '';
    const match = src.match(/assets\/index-([^/]+)\.js/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/** 拉取服务端最新入口 HTML，解析主 chunk hash；失败或未登录返回 null。 */
async function fetchLatestEntryHash(): Promise<string | null> {
  const response = await fetch(`/?_vc=${Date.now()}`, {
    cache: 'no-store',
    headers: { Accept: 'text/html' },
  });
  if (!response.ok) {
    return null;
  }
  const html = await response.text();
  const match = html.match(/assets\/index-([^/]+)\.js/);
  return match ? match[1] : null;
}

/**
 * 启动版本自检。
 * @param onUpdate 发现新版本时回调（参数为新 hash），调用后可停止定时器。
 * @returns 停止函数。
 */
export function startVersionCheck(onUpdate: (newHash: string) => void): () => void {
  const current = currentEntryHash();
  if (!current) {
    return () => {};
  }

  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const check = async () => {
    if (disposed) {
      return;
    }
    try {
      const latest = await fetchLatestEntryHash();
      if (!disposed && latest && latest !== current) {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        onUpdate(latest);
      }
    } catch {
      // 网络错误/未登录：忽略，下一轮重试
    }
  };

  timer = setInterval(check, CHECK_INTERVAL_MS);
  // 页面回到前台时立即检查一次（后台标签页可能长期不执行定时器）
  document.addEventListener('visibilitychange', () => {
    if (!disposed && document.visibilityState === 'visible') {
      void check();
    }
  });

  return () => {
    disposed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
