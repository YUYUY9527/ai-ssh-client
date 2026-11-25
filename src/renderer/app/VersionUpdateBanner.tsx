import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { startVersionCheck } from '../lib/version-check';
import { useI18n } from '../i18n';

/** 检测到新版本后的自动刷新倒计时（秒）。 */
const AUTO_RELOAD_DELAY_SECONDS = 5;

interface VersionUpdateBannerProps {
  hasTopBanner?: boolean;
}

/**
 * Web 模式版本自检提示条：
 * 检测到服务端已部署新版本时展示，倒计时结束后自动刷新页面，
 * 用户也可点击立即刷新或手动关闭（关闭后本次不再提示）。
 */
export function VersionUpdateBanner({ hasTopBanner = false }: VersionUpdateBannerProps) {
  const { t } = useI18n();
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
    <div
      className={`version-update-banner ${hasTopBanner ? 'version-update-banner-offset' : ''}`}
      role="status"
      aria-live="polite"
    >
      <RefreshCw className="h-4 w-4 flex-shrink-0 animate-spin text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg">{t('versionUpdate.title')}</div>
        <div className="mt-0.5 text-xs text-fg-muted">
          {secondsLeft > 0
            ? t('versionUpdate.countdown', { seconds: secondsLeft })
            : t('versionUpdate.reloading')}
        </div>
      </div>
      <button
        type="button"
        className="toolbar-button-primary h-7 shrink-0 px-2.5 text-xs"
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
        {t('versionUpdate.reloadNow')}
      </button>
      <button
        type="button"
        className="icon-button h-6 w-6 shrink-0"
        aria-label={t('common.close')}
        title={t('versionUpdate.dismissTitle')}
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
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
