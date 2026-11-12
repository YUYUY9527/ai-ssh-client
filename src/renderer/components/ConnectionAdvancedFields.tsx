import { ChevronDown, Plus, Trash2, ArrowUp, ArrowDown, Waypoints, ShieldCheck, ArrowLeftRight } from 'lucide-react';
import type { SSHConnection, SshJumpHost, SshProxyConfig, PortForwardRule } from '../../shared/types';
import { IndustrialSelect } from '../shared-ui/IndustrialSelect';

type Translate = (key: string) => string;
type ChangeHandler = (updater: (previous: SSHConnection | null) => SSHConnection | null) => void;

interface ConnectionAdvancedFieldsProps {
  connection: SSHConnection;
  connections: SSHConnection[];
  onChange: ChangeHandler;
  translate: Translate;
}

const EMPTY_JUMP: SshJumpHost = { host: '', port: 22, username: '' };

/**
 * 连接表单的高级区：代理（HTTP/SOCKS5）与多级跳板机。
 * 折叠起来时不占空间；展开后可直接编辑，也可从已保存连接导入某一跳的凭据。
 */
export function ConnectionAdvancedFields({
  connection,
  connections,
  onChange,
  translate,
}: ConnectionAdvancedFieldsProps) {
  const proxy = connection.proxy;
  const jumpHosts = connection.jumpHosts ?? [];
  const portForwards = connection.portForwards ?? [];

  const setForwards = (list: PortForwardRule[]) => {
    onChange((previous) => (previous ? { ...previous, portForwards: list.length > 0 ? list : undefined } : null));
  };

  const patchForward = (index: number, patch: Partial<PortForwardRule>) => {
    const list = [...portForwards];
    if (!list[index]) return;
    list[index] = { ...list[index], ...patch };
    setForwards(list);
  };

  const addForward = () => {
    const id = `pf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setForwards([
      ...portForwards,
      { id, type: 'local', bindHost: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: 22 },
    ]);
  };

  const moveForward = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= portForwards.length) return;
    const list = [...portForwards];
    const [item] = list.splice(index, 1);
    list.splice(target, 0, item);
    setForwards(list);
  };

  const importableConnections = connections.filter((item) => item.id !== connection.id);

  const patchProxy = (patch: Partial<SshProxyConfig> | null) => {
    onChange((previous) => {
      if (!previous) return null;
      if (patch === null) {
        const { proxy: _removed, ...rest } = previous;
        return rest;
      }
      const base: SshProxyConfig = previous.proxy ?? { type: 'socks5', host: '', port: 1080 };
      return { ...previous, proxy: { ...base, ...patch } };
    });
  };

  const patchJump = (index: number, patch: Partial<SshJumpHost>) => {
    onChange((previous) => {
      if (!previous) return null;
      const list = [...(previous.jumpHosts ?? [])];
      if (!list[index]) return previous;
      list[index] = { ...list[index], ...patch };
      return { ...previous, jumpHosts: list };
    });
  };

  const setJumps = (list: SshJumpHost[]) => {
    onChange((previous) => (previous ? { ...previous, jumpHosts: list.length > 0 ? list : undefined } : null));
  };

  const moveJump = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= jumpHosts.length) return;
    const list = [...jumpHosts];
    const [item] = list.splice(index, 1);
    list.splice(target, 0, item);
    setJumps(list);
  };

  return (
    <details className="industrial-card group p-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="workspace-empty-card-icon workspace-empty-card-icon-connect">
            <Waypoints className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="industrial-field-label mb-0 block">
              {translate('connection.form.advanced')}
            </span>
            <span className="block truncate text-xs text-fg-muted">
              {translate('connection.form.advancedHint')}
            </span>
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
      </summary>

      <div className="mt-4 space-y-4">
        {/* 代理 */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-fg-muted" />
            <span className="industrial-field-label mb-0">{translate('connection.form.proxy')}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="industrial-field-label">{translate('connection.form.proxyType')}</label>
              <IndustrialSelect
                value={proxy?.type ?? ''}
                options={[
                  { value: '', label: translate('connection.form.proxyNone') },
                  { value: 'socks5', label: 'SOCKS5' },
                  { value: 'http', label: 'HTTP CONNECT' },
                ]}
                onChange={(value) => {
                  if (!value) {
                    patchProxy(null);
                    return;
                  }
                  patchProxy({ type: value as SshProxyConfig['type'] });
                }}
                className="w-full"
              />
            </div>
            {proxy && (
              <div>
                <label className="industrial-field-label">{translate('connection.form.proxyPort')}</label>
                <input
                  type="number"
                  value={proxy.port || ''}
                  onChange={(event) => patchProxy({ port: parseInt(event.target.value, 10) || 0 })}
                  className="industrial-input w-full"
                  placeholder={proxy.type === 'http' ? '8080' : '1080'}
                />
              </div>
            )}
          </div>
          {proxy && (
            <>
              <input
                type="text"
                value={proxy.host}
                onChange={(event) => patchProxy({ host: event.target.value })}
                className="industrial-input w-full"
                placeholder={translate('connection.form.proxyHost')}
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  value={proxy.username || ''}
                  onChange={(event) => patchProxy({ username: event.target.value })}
                  className="industrial-input w-full"
                  placeholder={translate('connection.form.proxyUser')}
                />
                <input
                  type="password"
                  value={proxy.password || ''}
                  onChange={(event) => patchProxy({ password: event.target.value })}
                  className="industrial-input w-full"
                  placeholder={translate('connection.form.proxyPassword')}
                />
              </div>
            </>
          )}
        </div>

        {/* 跳板机 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="industrial-field-label mb-0">{translate('connection.form.jumpHosts')}</span>
            <button
              type="button"
              onClick={() => setJumps([...jumpHosts, { ...EMPTY_JUMP }])}
              className="industrial-button-secondary px-2 py-1"
            >
              <Plus className="h-4 w-4" />
              {translate('connection.form.addJumpHost')}
            </button>
          </div>
          <p className="text-xs text-fg-muted">{translate('connection.form.jumpHostsHint')}</p>

          {jumpHosts.map((hop, index) => (
            <div key={index} className="rounded-md border border-line bg-surface-sunken p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-fg-secondary">
                  {translate('connection.form.jumpHostIndex').replace('{index}', String(index + 1))}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveJump(index, -1)}
                    disabled={index === 0}
                    className="icon-button h-7 w-7 disabled:opacity-30"
                    title={translate('connection.form.moveUp')}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveJump(index, 1)}
                    disabled={index === jumpHosts.length - 1}
                    className="icon-button h-7 w-7 disabled:opacity-30"
                    title={translate('connection.form.moveDown')}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setJumps(jumpHosts.filter((_, i) => i !== index))}
                    className="icon-button h-7 w-7 text-danger"
                    title={translate('connection.form.remove')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <input
                    type="text"
                    value={hop.host}
                    onChange={(event) => patchJump(index, { host: event.target.value })}
                    className="industrial-input w-full"
                    placeholder={translate('connection.form.jumpHost')}
                  />
                </div>
                <input
                  type="number"
                  value={hop.port || 22}
                  onChange={(event) => patchJump(index, { port: parseInt(event.target.value, 10) || 22 })}
                  className="industrial-input w-full"
                  placeholder="22"
                />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={hop.username || ''}
                  onChange={(event) => patchJump(index, { username: event.target.value })}
                  className="industrial-input w-full"
                  placeholder={translate('connection.form.username')}
                />
                <input
                  type="password"
                  value={hop.password || ''}
                  onChange={(event) => patchJump(index, { password: event.target.value })}
                  className="industrial-input w-full"
                  placeholder={translate('connection.form.password')}
                />
              </div>
              <details className="mt-2 group/key">
                <summary className="cursor-pointer select-none text-xs text-fg-muted">
                  {translate('connection.form.jumpKeyOptional')}
                </summary>
                <textarea
                  value={hop.privateKey || ''}
                  onChange={(event) => patchJump(index, { privateKey: event.target.value })}
                  className="industrial-input mt-2 h-20 w-full resize-none font-mono text-xs"
                  placeholder={translate('connection.form.privateKeyPlaceholder')}
                />
                {hop.privateKey && (
                  <input
                    type="password"
                    value={hop.passphrase || ''}
                    onChange={(event) => patchJump(index, { passphrase: event.target.value })}
                    className="industrial-input mt-2 w-full"
                    placeholder={translate('connection.form.passphrasePlaceholder')}
                  />
                )}
              </details>
              {importableConnections.length > 0 && (
                <div className="mt-2">
                  <IndustrialSelect
                    value=""
                    options={[
                      { value: '', label: translate('connection.form.importJumpFromSaved') },
                      ...importableConnections.map((item) => ({
                        value: item.id,
                        label: `${item.name} (${item.username}@${item.host})`,
                      })),
                    ]}
                    onChange={(value) => {
                      const source = importableConnections.find((item) => item.id === value);
                      if (!source) return;
                      patchJump(index, {
                        host: source.host,
                        port: source.port,
                        username: source.username,
                        password: source.password,
                        privateKey: source.privateKey,
                        passphrase: source.passphrase,
                      });
                    }}
                    className="w-full"
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-5 border-t border-line-subtle pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-medium text-fg">
              <ArrowLeftRight className="h-3.5 w-3.5 text-accent" />
              <span>{translate('connection.form.portForwards')}</span>
            </div>
            <button type="button" className="toolbar-button px-2 py-1 text-xs" onClick={addForward}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {translate('connection.form.addPortForward')}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-fg-muted">{translate('connection.form.portForwardsHint')}</p>
          {portForwards.length === 0 ? (
            <p className="mt-2 text-[11px] text-fg-subtle">{translate('connection.form.portForwardsEmpty')}</p>
          ) : (
            <div className="mt-2 space-y-2">
              {portForwards.map((rule, index) => (
                <div key={rule.id} className="rounded-md border border-line bg-surface-raised p-2">
                  <div className="flex items-center gap-2">
                    <input
                      value={rule.label || ''}
                      onChange={(event) => patchForward(index, { label: event.target.value })}
                      className="industrial-input min-w-0 flex-1"
                      placeholder={translate('connection.form.portForwardLabel')}
                    />
                    <IndustrialSelect
                      value={rule.type}
                      options={[
                        { value: 'local', label: translate('connection.form.portForwardTypeLocal') },
                        { value: 'dynamic', label: translate('connection.form.portForwardTypeDynamic') },
                      ]}
                      onChange={(value) => patchForward(index, { type: value as PortForwardRule['type'] })}
                      className="w-28"
                    />
                    <button
                      type="button"
                      className="icon-button h-7 w-7"
                      title={translate('connection.form.moveUp')}
                      onClick={() => moveForward(index, -1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="icon-button h-7 w-7"
                      title={translate('connection.form.moveDown')}
                      onClick={() => moveForward(index, 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="icon-button h-7 w-7 text-danger"
                      title={translate('connection.form.remove')}
                      onClick={() => setForwards(portForwards.filter((item) => item.id !== rule.id))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="text-[11px] text-fg-muted">
                      {translate('connection.form.portForwardBindHost')}
                      <input
                        value={rule.bindHost || ''}
                        onChange={(event) => patchForward(index, { bindHost: event.target.value })}
                        className="industrial-input mt-1 w-full"
                        placeholder="127.0.0.1"
                      />
                    </label>
                    <label className="text-[11px] text-fg-muted">
                      {translate('connection.form.portForwardBindPort')}
                      <input
                        type="number"
                        value={Number.isFinite(rule.bindPort) ? rule.bindPort : 0}
                        onChange={(event) => patchForward(index, { bindPort: Number(event.target.value) || 0 })}
                        className="industrial-input mt-1 w-full"
                        placeholder="0"
                      />
                    </label>
                    {rule.type === 'local' && (
                      <>
                        <label className="text-[11px] text-fg-muted">
                          {translate('connection.form.portForwardTargetHost')}
                          <input
                            value={rule.targetHost || ''}
                            onChange={(event) => patchForward(index, { targetHost: event.target.value })}
                            className="industrial-input mt-1 w-full"
                            placeholder="127.0.0.1"
                          />
                        </label>
                        <label className="text-[11px] text-fg-muted">
                          {translate('connection.form.portForwardTargetPort')}
                          <input
                            type="number"
                            value={Number.isFinite(rule.targetPort) ? rule.targetPort : 0}
                            onChange={(event) => patchForward(index, { targetPort: Number(event.target.value) || 0 })}
                            className="industrial-input mt-1 w-full"
                            placeholder="22"
                          />
                        </label>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
