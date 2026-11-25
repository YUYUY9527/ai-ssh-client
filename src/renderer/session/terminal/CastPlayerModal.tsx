import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Download, Pause, Play, RotateCcw, Upload, X } from 'lucide-react';
import { parseCastFile, triggerCastDownload, type ParsedCastRecording } from './session-recorder';
import { TERMINAL_THEMES } from './terminal-theme';
import { Modal } from '../../shared-ui/Modal';

interface CastPlayerModalProps {
  isOpen: boolean;
  initialCast?: string | null;
  initialTitle?: string;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onClose: () => void;
}

const SPEEDS = [0.5, 1, 2, 4] as const;

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/** 内置 asciinema v2 `.cast` 终端录像播放器：支持本地加载、倍速、进度拖拽与下载。 */
export function CastPlayerModal({
  isOpen,
  initialCast,
  initialTitle,
  translate,
  onClose,
}: CastPlayerModalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rawCast, setRawCast] = useState<string | null>(initialCast || null);
  const [recording, setRecording] = useState<ParsedCastRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [currentSec, setCurrentSec] = useState(0);
  const indexRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    if (isOpen && initialCast) {
      setRawCast(initialCast);
    }
  }, [isOpen, initialCast]);

  useEffect(() => {
    if (!rawCast) {
      setRecording(null);
      return;
    }
    try {
      const parsed = parseCastFile(rawCast);
      setRecording(parsed);
      setError(null);
      setCurrentSec(0);
      indexRef.current = 0;
      setPlaying(false);
    } catch (caught) {
      setRecording(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [rawCast]);

  useEffect(() => {
    if (!isOpen || !hostRef.current) return undefined;
    const term = new XTerm({
      cols: recording?.header.width || 100,
      rows: recording?.header.height || 26,
      fontSize: 13,
      disableStdin: true,
      cursorBlink: false,
      theme: TERMINAL_THEMES.dark,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    try { fit.fit(); } catch { /* ignore */ }
    termRef.current = term;
    return () => {
      clearTimer();
      term.dispose();
      termRef.current = null;
    };
  }, [isOpen, recording]);

  const seekTo = useCallback((targetSec: number) => {
    clearTimer();
    setPlaying(false);
    const term = termRef.current;
    if (!term || !recording) return;
    term.reset();
    let idx = 0;
    while (idx < recording.events.length && recording.events[idx][0] <= targetSec) {
      const ev = recording.events[idx];
      if (ev[1] === 'o') term.write(ev[2]);
      idx += 1;
    }
    indexRef.current = idx;
    setCurrentSec(targetSec);
  }, [recording]);

  useEffect(() => {
    clearTimer();
    if (!playing || !recording || !termRef.current) return undefined;

    const step = () => {
      const term = termRef.current;
      if (!term) return;
      const idx = indexRef.current;
      if (idx >= recording.events.length) {
        setPlaying(false);
        setCurrentSec(recording.durationSec);
        return;
      }
      const ev = recording.events[idx];
      if (ev[1] === 'o') term.write(ev[2]);
      indexRef.current = idx + 1;
      setCurrentSec(ev[0]);
      const nextEv = recording.events[idx + 1];
      if (!nextEv) {
        setPlaying(false);
        return;
      }
      const rawDeltaMs = Math.max(0, (nextEv[0] - ev[0]) * 1000);
      // 单段静默最多压缩到 2.5s，避免回放长时间发呆
      const delayMs = Math.min(rawDeltaMs, 2500) / speed;
      timerRef.current = window.setTimeout(step, delayMs);
    };

    if (indexRef.current >= recording.events.length) {
      termRef.current.reset();
      indexRef.current = 0;
      setCurrentSec(0);
    }
    timerRef.current = window.setTimeout(step, 16);
    return clearTimer;
  }, [playing, recording, speed]);

  if (!isOpen) return null;

  const handleLoadFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setRawCast(reader.result);
      }
    };
    reader.readAsText(file);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      scope="global"
      size="3xl"
      closeLabel={translate('common.close')}
      panelClassName="flex h-[min(78vh,40rem)] flex-col overflow-hidden"
    >
        <div className="industrial-modal-header shrink-0">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-fg">
              {recording?.header.title || initialTitle || translate('features.recorder.playerTitle')}
            </h3>
          </div>
          <div className="flex items-center gap-1.5">
            <input ref={fileInputRef} type="file" accept=".cast,.json,text/plain" className="hidden" onChange={handleLoadFile} />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="industrial-button-secondary px-2.5 py-1 text-xs"
            >
              <Upload className="h-3.5 w-3.5" />
              {translate('features.recorder.loadCast')}
            </button>
            {rawCast && (
              <button
                type="button"
                onClick={() => triggerCastDownload(rawCast, `${recording?.header.title || 'session'}-${Date.now()}.cast`)}
                className="industrial-button-secondary px-2.5 py-1 text-xs"
              >
                <Download className="h-3.5 w-3.5" />
                {translate('features.recorder.downloadCast')}
              </button>
            )}
            <button type="button" onClick={onClose} className="icon-button h-7 w-7" aria-label={translate('common.close')}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 bg-surface-sunken p-2">
          {error ? (
            <div className="flex h-full items-center justify-center text-xs text-danger">{error}</div>
          ) : !recording ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-fg-muted">
              <p>{translate('features.recorder.emptyHint')}</p>
            </div>
          ) : (
            <div ref={hostRef} className="h-full w-full overflow-hidden rounded-sm border border-line-subtle" />
          )}
        </div>

        {recording && (
          <div className="flex items-center gap-3 border-t border-line-subtle bg-surface px-4 py-2.5">
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className="industrial-button-primary px-2.5 py-1 text-xs"
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => seekTo(0)}
              className="icon-button h-7 w-7"
              title={translate('features.recorder.restart')}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <span className="font-mono text-xs text-fg-muted tabular-nums">
              {formatTime(currentSec)} / {formatTime(recording.durationSec)}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0.1, recording.durationSec)}
              step={0.1}
              value={currentSec}
              onChange={(e) => seekTo(Number(e.target.value))}
              className="settings-range flex-1"
            />
            <div className="flex items-center gap-1">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSpeed(s)}
                  className={`rounded-sm px-1.5 py-0.5 font-mono text-[11px] ${
                    speed === s ? 'bg-accent-muted text-accent' : 'text-fg-muted hover:bg-surface-hover'
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>
        )}
    </Modal>
  );
}
