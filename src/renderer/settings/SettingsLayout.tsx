import type { ReactNode } from 'react';

/** 设置页统一的开关，三个设置文件共用，避免各自复制一份。 */
export function ToggleSwitch({
  enabled,
  label,
  onChange,
  disabled = false,
}: {
  enabled: boolean;
  label: string;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={`ui-toggle ${enabled ? 'ui-toggle-on' : 'ui-toggle-off'} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <span className="ui-toggle-thumb" />
    </button>
  );
}

/** 设置页外壳：统一标题层级、宽度和章节间距。 */
export function SettingsPage({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">{title}</h2>
          {description && (
            <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

/** 设置分组：标题 + 可选说明 + 带分隔线的条目列表。 */
export function SettingsSection({
  title,
  description,
  actions,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            {title && (
              <h3 className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">
                {title}
              </h3>
            )}
            {description && (
              <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
            )}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      <div className="divide-y divide-[color-mix(in_srgb,var(--border-color)_50%,transparent)] border-y border-[color-mix(in_srgb,var(--border-color)_50%,transparent)]">
        {children}
      </div>
    </section>
  );
}

/**
 * 单个设置项。
 * layout="inline"：标签在左、控件在右（开关、短下拉、窄输入框）。
 * layout="block"：控件在标签下方占满宽度（滑块、长文本、列表）。
 */
export function SettingsItem({
  label,
  description,
  htmlFor,
  layout = 'inline',
  controlClassName,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  layout?: 'inline' | 'block';
  controlClassName?: string;
  children: ReactNode;
}) {
  const heading = (
    <div className="min-w-0 space-y-0.5">
      {htmlFor ? (
        <label
          htmlFor={htmlFor}
          className="block text-sm font-medium text-slate-800 dark:text-slate-100"
        >
          {label}
        </label>
      ) : (
        <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{label}</div>
      )}
      {description && (
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
      )}
    </div>
  );

  if (layout === 'block') {
    return (
      <div className="space-y-2 py-3">
        {heading}
        {children}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      {heading}
      <div className={`shrink-0 ${controlClassName ?? ''}`}>{children}</div>
    </div>
  );
}