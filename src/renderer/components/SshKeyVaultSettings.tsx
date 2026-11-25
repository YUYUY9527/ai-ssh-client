import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Plus, Send, Sparkles, Trash2 } from 'lucide-react';
import type { SSHKeyRecord } from '../../shared/types';
import { useI18n } from '../i18n';
import { useSessionStore } from '../session/useSessionStore';
import { SettingsPage, SettingsSection } from '../settings/SettingsLayout';
import { IndustrialSelect } from '../shared-ui/IndustrialSelect';

/**
 * SSH 独立密钥库（Key Vault）：
 * - 集中管理/导入私钥，多台主机通过 keyId 复用
 * - 在线生成 Ed25519 / RSA-4096 密钥对
 * - 一键复制公钥或部署公钥到当前活跃 SSH 会话的 authorized_keys
 */
export function SshKeyVaultSettings() {
  const { t } = useI18n();
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const activeSession = useSessionStore((state) => (
    state.activeSessionId ? state.sessions[state.activeSessionId] : null
  ));
  const [keys, setKeys] = useState<SSHKeyRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'none' | 'generate' | 'import'>('none');
  const [busy, setBusy] = useState(false);

  // 生成表单
  const [genName, setGenName] = useState('');
  const [genAlg, setGenAlg] = useState<'ed25519' | 'rsa'>('ed25519');
  const [genPassphrase, setGenPassphrase] = useState('');

  // 导入表单
  const [impName, setImpName] = useState('');
  const [impPrivateKey, setImpPrivateKey] = useState('');
  const [impPassphrase, setImpPassphrase] = useState('');

  const loadKeys = useCallback(async () => {
    if (!window.electronAPI?.listSshKeys) return;
    setLoading(true);
    try {
      const result = await window.electronAPI.listSshKeys();
      if (result.success) {
        setKeys(result.data.keys || []);
        setError(null);
      } else {
        setError(result.error);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const handleGenerate = async () => {
    if (!window.electronAPI?.generateSshKey) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.electronAPI.generateSshKey({
        name: genName.trim() || `Key (${genAlg.toUpperCase()})`,
        algorithm: genAlg,
        passphrase: genPassphrase || undefined,
      });
      if (!result.success) {
        setError(result.error);
      } else {
        setGenName('');
        setGenPassphrase('');
        setMode('none');
        setNotice(t('features.keyVault.generated'));
        await loadKeys();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (!window.electronAPI?.saveSshKey) return;
    if (!impName.trim() || !impPrivateKey.trim()) {
      setError(t('features.keyVault.importRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.electronAPI.saveSshKey({
        name: impName.trim(),
        privateKey: impPrivateKey,
        passphrase: impPassphrase || undefined,
      });
      if (!result.success) {
        setError(result.error);
      } else {
        setImpName('');
        setImpPrivateKey('');
        setImpPassphrase('');
        setMode('none');
        setNotice(t('features.keyVault.imported'));
        await loadKeys();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.electronAPI?.deleteSshKey) return;
    setError(null);
    setNotice(null);
    const result = await window.electronAPI.deleteSshKey(id);
    if (!result.success) {
      setError(result.error);
      return;
    }
    await loadKeys();
  };

  const handleCopyPublicKey = async (key: SSHKeyRecord) => {
    if (!key.publicKey) return;
    try {
      await navigator.clipboard.writeText(key.publicKey);
      setCopiedId(key.id);
      window.setTimeout(() => setCopiedId((prev) => (prev === key.id ? null : prev)), 1600);
    } catch {
      setError(t('features.keyVault.copyFailed'));
    }
  };

  const handleDeploy = async (key: SSHKeyRecord) => {
    if (!window.electronAPI?.deploySshKey || !activeSessionId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.electronAPI.deploySshKey(activeSessionId, key.id);
      if (!result.success) {
        setError(result.error);
      } else {
        setNotice(
          result.data.alreadyPresent
            ? t('features.keyVault.alreadyDeployed')
            : t('features.keyVault.deployed'),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const canDeploy = Boolean(activeSessionId && activeSession?.state === 'connected');

  return (
    <SettingsPage
      title={t('features.keyVault.title')}
      description={t('features.keyVault.description')}
    >
      <SettingsSection
        title={t('features.keyVault.storedKeys')}
        actions={(
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setMode(mode === 'generate' ? 'none' : 'generate')}
              className="industrial-button-primary px-2.5 py-1.5 text-xs"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t('features.keyVault.generate')}
            </button>
            <button
              type="button"
              onClick={() => setMode(mode === 'import' ? 'none' : 'import')}
              className="industrial-button-secondary px-2.5 py-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('features.keyVault.import')}
            </button>
          </div>
        )}
      >
        <div className="space-y-3 py-3">
          {error && (
            <div className="rounded-md border border-danger bg-danger-muted px-3 py-2 text-xs text-danger-fg">
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-md border border-success bg-success-muted px-3 py-2 text-xs text-success-fg">
              {notice}
            </div>
          )}

          {mode === 'generate' && (
            <div className="industrial-card space-y-2.5 p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <label className="industrial-field-label">{t('features.keyVault.keyName')}</label>
                  <input
                    type="text"
                    value={genName}
                    onChange={(e) => setGenName(e.target.value)}
                    placeholder="prod-ed25519"
                    className="industrial-input w-full"
                  />
                </div>
                <div>
                  <label className="industrial-field-label">{t('features.keyVault.algorithm')}</label>
                  <IndustrialSelect
                    value={genAlg}
                    options={[
                      { value: 'ed25519', label: 'Ed25519 (Recommended)' },
                      { value: 'rsa', label: 'RSA 4096' },
                    ]}
                    onChange={(value) => setGenAlg(value as 'ed25519' | 'rsa')}
                    className="w-full"
                  />
                </div>
              </div>
              <div>
                <label className="industrial-field-label">{t('features.keyVault.passphraseOptional')}</label>
                <input
                  type="password"
                  value={genPassphrase}
                  onChange={(e) => setGenPassphrase(e.target.value)}
                  className="industrial-input w-full"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setMode('none')} className="industrial-button-secondary px-3 py-1 text-xs">
                  {t('common.cancel')}
                </button>
                <button type="button" disabled={busy} onClick={() => void handleGenerate()} className="industrial-button-primary px-3 py-1 text-xs">
                  {t('features.keyVault.generateNow')}
                </button>
              </div>
            </div>
          )}

          {mode === 'import' && (
            <div className="industrial-card space-y-2.5 p-3">
              <div>
                <label className="industrial-field-label">{t('features.keyVault.keyName')}</label>
                <input
                  type="text"
                  value={impName}
                  onChange={(e) => setImpName(e.target.value)}
                  placeholder="my-server-key"
                  className="industrial-input w-full"
                />
              </div>
              <div>
                <label className="industrial-field-label">{t('connection.form.privateKey')}</label>
                <textarea
                  rows={4}
                  value={impPrivateKey}
                  onChange={(e) => setImpPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  className="industrial-input w-full font-mono text-xs"
                  spellCheck={false}
                />
              </div>
              <div>
                <label className="industrial-field-label">{t('features.keyVault.passphraseOptional')}</label>
                <input
                  type="password"
                  value={impPassphrase}
                  onChange={(e) => setImpPassphrase(e.target.value)}
                  className="industrial-input w-full"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setMode('none')} className="industrial-button-secondary px-3 py-1 text-xs">
                  {t('common.cancel')}
                </button>
                <button type="button" disabled={busy} onClick={() => void handleImport()} className="industrial-button-primary px-3 py-1 text-xs">
                  {t('common.save')}
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <p className="py-4 text-center text-xs text-fg-muted">{t('common.loading')}</p>
          ) : keys.length === 0 ? (
            <div className="rounded-md border border-dashed border-line-subtle px-3 py-5 text-center text-xs text-fg-muted">
              {t('features.keyVault.empty')}
            </div>
          ) : (
            <div className="space-y-2">
              {keys.map((key) => (
                <div key={key.id} className="industrial-card flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <KeyRound className="h-3.5 w-3.5 shrink-0 text-accent" />
                      <span className="truncate text-sm font-medium text-fg">{key.name}</span>
                      <span className="rounded-sm bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
                        {key.algorithm}
                      </span>
                    </div>
                    <div className="truncate font-mono text-[11px] text-fg-muted" title={key.fingerprint}>
                      {key.fingerprint}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {key.publicKey && (
                      <button
                        type="button"
                        onClick={() => void handleCopyPublicKey(key)}
                        className="industrial-button-secondary px-2 py-1 text-xs"
                        title={t('features.keyVault.copyPublicKey')}
                      >
                        {copiedId === key.id ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                        {t('features.keyVault.copyPublicKey')}
                      </button>
                    )}
                    {canDeploy && key.publicKey && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleDeploy(key)}
                        className="industrial-button-secondary px-2 py-1 text-xs"
                        title={t('features.keyVault.deployHint')}
                      >
                        <Send className="h-3.5 w-3.5" />
                        {t('features.keyVault.deploy')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleDelete(key.id)}
                      className="icon-button h-7 w-7 text-danger"
                      title={t('common.delete')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
