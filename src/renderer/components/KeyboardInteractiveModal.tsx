import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { SshKeyboardInteractivePrompt } from '../../shared/types';
import { Modal } from '../shared-ui/Modal';

interface KeyboardInteractiveModalProps {
  prompt: SshKeyboardInteractivePrompt | null;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onSubmit: (requestId: string, answers: string[]) => void;
  onCancel: (requestId: string) => void;
}

/**
 * SSH 键盘交互认证（2FA / OTP / PAM）弹窗。
 * 收到服务端 `ssh-kb-interactive-prompt` 事件时展示，按 prompt.echo 控制明文或密码输入。
 */
export function KeyboardInteractiveModal({
  prompt,
  translate,
  onSubmit,
  onCancel,
}: KeyboardInteractiveModalProps) {
  const [answers, setAnswers] = useState<string[]>([]);

  useEffect(() => {
    if (!prompt) {
      setAnswers([]);
      return;
    }
    setAnswers(prompt.prompts.map(() => ''));
  }, [prompt]);

  if (!prompt) return null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onSubmit(prompt.requestId, answers);
  };

  return (
    <Modal
      isOpen
      onClose={() => onCancel(prompt.requestId)}
      scope="global"
      size="md"
      closeLabel={translate('common.close')}
      title={(
        <span className="flex items-center gap-2 text-sm font-semibold text-fg">
          <ShieldCheck className="h-4 w-4 text-accent" />
          <span>{translate('features.keyboardInteractive.title')}</span>
        </span>
      )}
    >
      <form onSubmit={handleSubmit}>
        <div className="space-y-3 p-4">
          <div className="rounded-sm border border-line-subtle bg-surface-sunken px-3 py-2 text-xs text-fg-muted">
            <div className="font-mono text-fg">
              {prompt.host}:{prompt.port}
            </div>
            {prompt.name && <div className="mt-1 font-medium text-fg-secondary">{prompt.name}</div>}
            {prompt.instructions && (
              <p className="mt-1 whitespace-pre-wrap text-fg-muted">{prompt.instructions}</p>
            )}
          </div>

          {prompt.prompts.map((item, index) => (
            <div key={index}>
              <label className="industrial-field-label">
                {item.prompt || translate('features.keyboardInteractive.defaultPrompt')}
              </label>
              <input
                type={item.echo ? 'text' : 'password'}
                autoFocus={index === 0}
                autoComplete="one-time-code"
                value={answers[index] ?? ''}
                onChange={(event) => {
                  const next = [...answers];
                  next[index] = event.target.value;
                  setAnswers(next);
                }}
                className="industrial-input w-full font-mono"
              />
            </div>
          ))}
        </div>

        <div className="industrial-modal-footer">
          <button
            type="button"
            onClick={() => onCancel(prompt.requestId)}
            className="industrial-button-secondary"
          >
            {translate('common.cancel')}
          </button>
          <button type="submit" className="industrial-button-primary">
            {translate('common.confirm')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
