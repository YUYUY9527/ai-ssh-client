# UI Design Tokens & Shared Chrome Classes

Single source of truth lives in `src/renderer/index.css` (`@layer base` CSS variables) and shared component classes in `@layer components`.

## Semantic tokens (dark + light)

| Token | Role |
|-------|------|
| `--bg-primary` / `--bg-secondary` / `--bg-tertiary` / `--bg-hover` | Surfaces |
| `--border-color` | Borders |
| `--text-primary` / `--text-secondary` / `--text-muted` | Type |
| `--accent-primary` / `--accent-hover` / `--accent-muted` / `--accent-strong` | Brand accent (teal) + alert orange |
| `--accent-gradient-from` / `--accent-gradient-to` | Primary button fill |
| `--success` / `--success-muted` / `--success-fg` | Connected / success |
| `--warning` / `--warning-muted` / `--warning-fg` | Connecting / caution |
| `--danger` / `--danger-muted` / `--danger-fg` | Error / destructive |
| `--info` / `--info-muted` | Secondary highlight (AI cue) |
| `--radius-sm` (6) / `--radius-md` (8) / `--radius-lg` (12) | Corner scale |
| `--shadow-sm` / `--shadow-md` / `--shadow-lg` | Elevation |
| `--duration-chrome` / `--ease-chrome` | Open/close motion |

## Shared control / shell classes

| Class | Use |
|-------|-----|
| `app-shell`, `app-header`, `app-title-mark`, `app-main`, `app-footer` | App chrome |
| `toolbar-group`, `toolbar-button`, `toolbar-button-primary`, `toolbar-button-active`, `icon-button` | Header tools |
| `app-popover`, `app-popover-header`, `app-popover-row` | Dropdowns |
| `workspace-tabbar`, `workspace-tab`, `workspace-tab-active`, `workspace-tab-close`, `status-dot-*` | Session tabs |
| `workspace-empty`, `workspace-empty-mark`, `workspace-empty-card-icon-*` | Empty workspace |
| `toast-host`, `toast-item`, `toast-item-success`, `toast-item-error` | Toasts |
| `industrial-modal`, `industrial-modal-header`, `industrial-modal-footer`, `modal-backdrop` | Modals |
| `industrial-input`, `industrial-card`, `industrial-field-label`, `industrial-setting-row` | Forms / cards |
| `industrial-button-primary`, `industrial-button-secondary`, `industrial-button-danger` | Actions |
| `settings-nav-item`, `settings-nav-item-active`, `ui-toggle`, `ui-toggle-*` | Settings |
| `connection-list-row`, `connection-list-row-active`, `sftp-sidebar` | Connections / SFTP |
| `terminal-toolbar`, `terminal-control`, `terminal-control-active` | Terminal chrome |
| `agent-pet-*`, `agent-chat-*` | Assistant chrome |
| `text-success`, `text-warning`, `text-danger`, `text-accent` | Semantic text |

## Motion

Chrome open uses `ui-chrome-in` / `ui-toast-in` / `ui-fade-in` with `--duration-chrome`.  
`prefers-reduced-motion: reduce` disables non-essential animation/transition durations.

## Confirm / Modal consolidation

- `shared-ui/Modal.tsx` — single modal presentation (sizes sm/md/lg/xl, header, backdrop, focus trap)
- `components/ConfirmDialog.tsx` — single confirm UX (danger vs primary)
- `shared-ui/ConfirmDialog.tsx` and `settings/SettingsPanel.tsx` re-export the shared implementations
