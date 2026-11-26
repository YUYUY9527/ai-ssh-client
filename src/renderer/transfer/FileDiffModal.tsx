import { useEffect, useMemo, useState } from 'react';
import { GitCompare, Loader2 } from 'lucide-react';
import { Modal } from '../shared-ui/Modal';
import { IndustrialSelect } from '../shared-ui/IndustrialSelect';
import { useI18n } from '../i18n';
import { useSessionStore } from '../session/useSessionStore';
import { useSessionOverlay } from '../workspace/SessionOverlayContext';
import { computeLineDiff } from './line-diff';

interface FileDiffModalProps {
  isOpen: boolean;
  leftConnectionId: string;
  leftPath: string;
  onClose: () => void;
}

/** 远端文件差异对比弹窗：支持同机任意路径对比，或跨已连接服务器对比同名/指定文件。 */
export function FileDiffModal({
  isOpen,
  leftConnectionId,
  leftPath,
  onClose,
}: FileDiffModalProps) {
  const { t } = useI18n();
  const overlay = useSessionOverlay();
  const sessions = useSessionStore((state) => state.sessions);
  const connectedSessions = useMemo(
    () => Object.values(sessions).filter((s) => s.state === 'connected'),
    [sessions],
  );

  const [rightConnectionId, setRightConnectionId] = useState(leftConnectionId);
  const [rightPath, setRightPath] = useState(leftPath);
  const [leftText, setLeftText] = useState('');
  const [rightText, setRightText] = useState('');
  const [loading, setLoading] = useState(false);
  const [compared, setCompared] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setRightConnectionId(leftConnectionId);
      setRightPath(leftPath);
      setLeftText('');
      setRightText('');
      setCompared(false);
      setError(null);
    }
  }, [isOpen, leftConnectionId, leftPath]);

  const handleCompare = async () => {
    if (!window.electronAPI?.readSftpTextFile || !rightPath.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const [lRes, rRes] = await Promise.all([
        window.electronAPI.readSftpTextFile(leftConnectionId, leftPath),
        window.electronAPI.readSftpTextFile(rightConnectionId, rightPath.trim()),
      ]);
      if (!lRes.success) {
        setError(`${leftPath}: ${lRes.error}`);
        return;
      }
      if (!rRes.success) {
        setError(`${rightPath.trim()}: ${rRes.error}`);
        return;
      }
      setLeftText(lRes.data.content || '');
      setRightText(rRes.data.content || '');
      setCompared(true);
    } finally {
      setLoading(false);
    }
  };

  const diff = useMemo(
    () => (compared ? computeLineDiff(leftText, rightText) : null),
    [compared, leftText, rightText],
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="4xl"
      closeLabel={t('common.close')}
      panelClassName={
        overlay.container
          ? 'flex !h-[min(94%,860px)] !max-h-full flex-col !overflow-hidden'
          : 'flex !h-[min(90vh,860px)] !max-h-[min(90vh,860px)] flex-col !overflow-hidden'
      }
      title={(
        <span className="flex items-center gap-2">
          <GitCompare className="h-4 w-4 shrink-0 text-accent" />
          <span className="truncate text-sm">{t('fileTransfer.diffTitle')}</span>
        </span>
      )}
    >
      <div className="shrink-0 space-y-2 border-b border-line-subtle p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-12 shrink-0 text-fg-muted">{t('fileTransfer.diffLeft')}</span>
          <span className="min-w-0 flex-1 truncate rounded-sm border border-line-subtle bg-surface-sunken px-2 py-1 font-mono text-fg">
            {leftPath}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-12 shrink-0 text-fg-muted">{t('fileTransfer.diffRight')}</span>
          {connectedSessions.length > 1 && (
            <div className="w-40 shrink-0">
              <IndustrialSelect
                value={rightConnectionId}
                onChange={setRightConnectionId}
                options={connectedSessions.map((s) => ({ value: s.id, label: s.title }))}
              />
            </div>
          )}
          <input
            type="text"
            value={rightPath}
            onChange={(event) => setRightPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleCompare();
            }}
            placeholder="/path/to/compare"
            className="industrial-input h-8 min-w-[200px] flex-1 font-mono text-xs"
          />
          <button
            type="button"
            disabled={loading || !rightPath.trim()}
            onClick={() => { void handleCompare(); }}
            className="industrial-button-primary h-8 px-3 text-xs"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCompare className="h-3.5 w-3.5" />}
            <span>{t('fileTransfer.diffRun')}</span>
          </button>
        </div>
        {diff && (
          <div className="flex items-center gap-3 font-mono text-[11px]">
            <span className="text-success">+{diff.added}</span>
            <span className="text-danger">-{diff.removed}</span>
            <span className="text-fg-muted">{t('fileTransfer.diffUnchanged', { count: diff.unchanged })}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="border-b border-danger-muted bg-danger-muted px-4 py-1.5 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto bg-[var(--bg-primary)] font-mono text-[11px] leading-5">
        {!diff ? (
          <div className="flex h-full items-center justify-center p-6 text-xs text-fg-muted">
            {t('fileTransfer.diffHint')}
          </div>
        ) : diff.added === 0 && diff.removed === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-xs text-success">
            {t('fileTransfer.diffIdentical')}
          </div>
        ) : (
          <div className="py-1">
            {diff.lines.map((line, index) => (
              <div
                key={index}
                className={`flex whitespace-pre-wrap break-all px-3 ${
                  line.kind === 'add'
                    ? 'bg-success-muted text-success'
                    : line.kind === 'remove'
                      ? 'bg-danger-muted text-danger'
                      : 'text-fg-secondary'
                }`}
              >
                <span className="w-9 shrink-0 select-none pr-2 text-right text-fg-subtle tabular-nums">
                  {line.leftLine ?? ''}
                </span>
                <span className="w-9 shrink-0 select-none pr-2 text-right text-fg-subtle tabular-nums">
                  {line.rightLine ?? ''}
                </span>
                <span className="w-4 shrink-0 select-none font-semibold">
                  {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                </span>
                <span className="min-w-0 flex-1">{line.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
