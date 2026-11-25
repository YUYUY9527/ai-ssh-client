import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import type { SSHConnection, WebUserRole, WebUserSummary } from '../../shared/types';
import { useI18n } from '../i18n';
import { useConnectionStore } from '../store/useConnectionStore';
import { SettingsSection } from '../settings/SettingsLayout';

/**
 * Web 鉴权增强面板（挂载在 设置 → 密码/安全 页）：
 * - 双因素认证（TOTP 2FA）配置与开关
 * - 多用户与 RBAC 角色/连接级权限管理
 */
export function AuthSecurityPanel() {
  const { t } = useI18n();
  const connections: SSHConnection[] = useConnectionStore((state) => state.connections);
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpMsg, setTotpMsg] = useState<string | null>(null);
  const [totpErr, setTotpErr] = useState<string | null>(null);

  const [users, setUsers] = useState<WebUserSummary[]>([]);
  const [userFormOpen, setUserFormOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<WebUserRole>('operator');
  const [allowedIds, setAllowedIds] = useState<Set<string>>(new Set());
  const [userErr, setUserErr] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    if (window.electronAPI?.getAuthStatus) {
      const status = await window.electronAPI.getAuthStatus();
      if (status.success) {
        setTotpEnabled(Boolean(status.data.totpEnabled));
      }
    }
    if (window.electronAPI?.listWebUsers) {
      const res = await window.electronAPI.listWebUsers();
      if (res.success) setUsers(res.data.users || []);
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const handleStartTotpSetup = async () => {
    if (!window.electronAPI?.setupWebTotp) return;
    setTotpErr(null);
    setTotpMsg(null);
    const res = await window.electronAPI.setupWebTotp();
    if (!res.success) setTotpErr(res.error);
    else setTotpSetup(res.data);
  };

  const handleEnableTotp = async () => {
    if (!window.electronAPI?.enableWebTotp) return;
    setTotpErr(null);
    setTotpMsg(null);
    const res = await window.electronAPI.enableWebTotp(totpCode.trim());
    if (!res.success) {
      setTotpErr(res.error);
    } else {
      setTotpEnabled(true);
      setTotpSetup(null);
      setTotpCode('');
      setTotpMsg(t('features.authSecurity.totpEnabledMsg'));
    }
  };

  const handleDisableTotp = async () => {
    if (!window.electronAPI?.disableWebTotp) return;
    setTotpErr(null);
    setTotpMsg(null);
    const res = await window.electronAPI.disableWebTotp(totpCode.trim());
    if (!res.success) {
      setTotpErr(res.error);
    } else {
      setTotpEnabled(false);
      setTotpCode('');
      setTotpMsg(t('features.authSecurity.totpDisabledMsg'));
    }
  };

  const handleSaveUser = async () => {
    if (!window.electronAPI?.saveWebUser) return;
    setUserErr(null);
    const res = await window.electronAPI.saveWebUser({
      username: newUsername.trim(),
      password: newPassword,
      role: newRole,
      allowedConnectionIds: Array.from(allowedIds),
    });
    if (!res.success) {
      setUserErr(res.error);
    } else {
      setNewUsername('');
      setNewPassword('');
      setNewRole('operator');
      setAllowedIds(new Set());
      setUserFormOpen(false);
      await loadState();
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (!window.electronAPI?.deleteWebUser) return;
    const res = await window.electronAPI.deleteWebUser(userId);
    if (!res.success) setUserErr(res.error);
    else await loadState();
  };

  return (
    <div className="mt-6 space-y-6">
      {/* TOTP 2FA */}
      <SettingsSection
        title={(
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-accent" />
            {t('features.authSecurity.totpTitle')}
          </span>
        )}
        description={t('features.authSecurity.totpDesc')}
      >
        <div className="space-y-3 py-3">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-fg-secondary">
              {t('features.authSecurity.status')}:{' '}
              <strong className={totpEnabled ? 'text-success' : 'text-fg-muted'}>
                {totpEnabled ? t('features.authSecurity.enabled') : t('features.authSecurity.disabled')}
              </strong>
            </span>
            {!totpEnabled && !totpSetup && (
              <button type="button" onClick={() => void handleStartTotpSetup()} className="industrial-button-primary px-3 py-1 text-xs">
                {t('features.authSecurity.setupTotp')}
              </button>
            )}
          </div>

          {totpSetup && (
            <div className="industrial-card space-y-2.5 p-3 text-xs">
              <p className="text-fg-secondary">{t('features.authSecurity.totpSecretHint')}</p>
              <div className="rounded-sm border border-line-subtle bg-surface-sunken px-2.5 py-2 font-mono text-xs text-accent select-all">
                {totpSetup.secret}
              </div>
              <div className="break-all font-mono text-[10px] text-fg-muted select-all">
                {totpSetup.otpauthUri}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="000000"
                  className="industrial-input w-32 font-mono text-xs"
                />
                <button type="button" onClick={() => void handleEnableTotp()} className="industrial-button-primary px-3 py-1 text-xs">
                  {t('features.authSecurity.verifyAndEnable')}
                </button>
                <button type="button" onClick={() => setTotpSetup(null)} className="industrial-button-secondary px-2.5 py-1 text-xs">
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}

          {totpEnabled && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder={t('features.authSecurity.currentCodePlaceholder')}
                className="industrial-input w-40 font-mono text-xs"
              />
              <button type="button" onClick={() => void handleDisableTotp()} className="industrial-button-secondary px-3 py-1 text-xs text-danger">
                {t('features.authSecurity.disableTotp')}
              </button>
            </div>
          )}

          {totpErr && <p className="text-xs text-danger">{totpErr}</p>}
          {totpMsg && <p className="text-xs text-accent">{totpMsg}</p>}
        </div>
      </SettingsSection>

      {/* 多用户与 RBAC */}
      <SettingsSection
        title={(
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-accent" />
            {t('features.authSecurity.usersTitle')}
          </span>
        )}
        description={t('features.authSecurity.usersDesc')}
        actions={(
          <button
            type="button"
            onClick={() => setUserFormOpen((v) => !v)}
            className="industrial-button-primary px-2.5 py-1 text-xs"
          >
            <UserPlus className="h-3.5 w-3.5" />
            {t('features.authSecurity.addUser')}
          </button>
        )}
      >
        <div className="space-y-3 py-3">
          {userErr && <p className="text-xs text-danger">{userErr}</p>}

          {userFormOpen && (
            <div className="industrial-card space-y-2.5 p-3 text-xs">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <input
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder={t('features.authSecurity.username')}
                  className="industrial-input"
                />
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t('connection.form.password')}
                  className="industrial-input"
                />
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as WebUserRole)}
                  className="industrial-input"
                >
                  <option value="admin">admin</option>
                  <option value="operator">operator</option>
                  <option value="viewer">viewer</option>
                </select>
              </div>
              {connections.length > 0 && newRole !== 'admin' && (
                <div>
                  <div className="mb-1 text-[11px] text-fg-muted">{t('features.authSecurity.allowedConnectionsHint')}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {connections.map((conn) => {
                      const active = allowedIds.has(conn.id);
                      return (
                        <button
                          key={conn.id}
                          type="button"
                          onClick={() => setAllowedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(conn.id)) next.delete(conn.id);
                            else next.add(conn.id);
                            return next;
                          })}
                          className={`rounded-sm border px-2 py-0.5 text-[11px] ${
                            active ? 'border-accent bg-accent-muted text-accent' : 'border-line-subtle bg-surface text-fg-muted'
                          }`}
                        >
                          {conn.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setUserFormOpen(false)} className="industrial-button-secondary px-2.5 py-1 text-xs">
                  {t('common.cancel')}
                </button>
                <button type="button" onClick={() => void handleSaveUser()} className="industrial-button-primary px-3 py-1 text-xs">
                  {t('common.save')}
                </button>
              </div>
            </div>
          )}

          {users.length === 0 ? (
            <div className="rounded-md border border-dashed border-line-subtle px-3 py-4 text-center text-xs text-fg-muted">
              {t('features.authSecurity.noExtraUsers')}
            </div>
          ) : (
            <div className="space-y-1.5">
              {users.map((u) => (
                <div key={u.id} className="industrial-card flex items-center justify-between gap-2 px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-fg">{u.username}</span>
                      <span className="rounded-sm bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] uppercase text-accent">
                        {u.role}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-fg-muted">
                      {u.allowedConnectionIds && u.allowedConnectionIds.length > 0
                        ? `${u.allowedConnectionIds.length} ${t('features.authSecurity.scopedConnections')}`
                        : t('features.authSecurity.allConnections')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDeleteUser(u.id)}
                    className="icon-button h-7 w-7 text-danger"
                    title={t('common.delete')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
