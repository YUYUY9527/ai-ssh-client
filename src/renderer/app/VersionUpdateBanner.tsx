import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { startVersionCheck } from '../lib/version-check';

/** 检测到新版本后的自动刷新倒计时（秒）。 */
const AUTO_RELOAD_DELAY_SECONDS = 5;

/**
 * Web 模式版本自检提示条：
 * 检测到服务端已部署新版本时展示，倒计时结束后自动刷新页面，
 * 用户也可点击立即刷新或手动关闭（关闭后本次不再提示）。
 */
export function VersionUpdateBanner() {
  const [visible, setVisible] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(AUTO_RELOAD_DELAY_SECONDS);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const stopVersionCheck = startVersionCheck(() => {
      setVisible(true);
      setSecondsLeft(AUTO_RELOAD_DELAY_SECONDS);
      tickTimer.current = setInterval(() => {
        setSecondsLeft((prev) => {
          if (prev <= 1) {
            if (tickTimer.current) {
              clearInterval(tickTimer.current);
              tickTimer.current = null;
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      reloadTimer.current = setTimeout(() => {
        window.location.reload();
      }, AUTO_RELOAD_DELAY_SECONDS * 1000);
    });

    return () => {
      stopVersionCheck();
      if (reloadTimer.current) {
        clearTimeout(reloadTimer.current);
        reloadTimer.current = null;
      }
      if (tickTimer.current) {
        clearInterval(tickTimer.current);
        tickTimer.current = null;
      }
    };
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <div className="version-update-banner" role="status" aria-live="polite">
      <RefreshCw className="h-4 w-4 flex-shrink-0 animate-spin" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">检测到新版本</div>
        <div className="mt-0.5 text-xs opacity-80">
          {secondsLeft > 0
            ? `${secondsLeft} 秒后自动刷新以加载最新版本…`
            : '正在刷新…'}
        </div>
      </div>
      <button
        type="button"
        className="rounded bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25"
        onClick={() => {
          if (reloadTimer.current) {
            clearTimeout(reloadTimer.current);
            reloadTimer.current = null;
          }
          if (tickTimer.current) {
            clearInterval(tickTimer.current);
            tickTimer.current = null;
          }
          window.location.reload();
        }}
      >
        立即刷新
      </button>
      <button
        type="button"
        className="icon-button h-6 w-6 opacity-70 hover:opacity-100"
        aria-label="关闭"
        title="本次不再提示"
        onClick={() => {
          if (reloadTimer.current) {
            clearTimeout(reloadTimer.current);
            reloadTimer.current = null;
          }
          if (tickTimer.current) {
            clearInterval(tickTimer.current);
            tickTimer.current = null;
          }
          setVisible(false);
        }}
      >
        ×
      </button>
    </div>
  );
}
