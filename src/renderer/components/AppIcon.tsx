interface AppIconProps {
  className?: string;
}

export function AppIcon({ className = 'h-4 w-4' }: AppIconProps) {
  return (
    <svg className={className} viewBox="0 0 256 256" aria-hidden="true">
      <defs>
        <linearGradient id="app-icon-base" x1="42" y1="18" x2="214" y2="238" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#12343a" />
          <stop offset="0.5" stopColor="#081016" />
          <stop offset="1" stopColor="#020609" />
        </linearGradient>
        <linearGradient id="app-icon-edge" x1="42" y1="24" x2="214" y2="232" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="0.58" stopColor="#14b8a6" />
          <stop offset="1" stopColor="#f97316" />
        </linearGradient>
        <linearGradient id="app-icon-bolt" x1="96" y1="58" x2="168" y2="190" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a7f3d0" />
          <stop offset="0.42" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#0f766e" />
        </linearGradient>
      </defs>
      <rect x="18" y="18" width="220" height="220" rx="44" fill="url(#app-icon-base)" />
      <rect x="24" y="24" width="208" height="208" rx="38" fill="none" stroke="url(#app-icon-edge)" strokeWidth="8" />
      <path d="M61 78h69l23 50-23 50H61l26-50-26-50Z" fill="#0b1419" stroke="#2dd4bf" strokeWidth="10" strokeLinejoin="round" />
      <path d="M91 76l-25 52 25 52" fill="none" stroke="#f5f7f2" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M126 62l-21 66h39l-16 66 60-84h-42l20-48h-40Z" fill="url(#app-icon-bolt)" stroke="#ccfbf1" strokeWidth="5" strokeLinejoin="round" />
      <path d="M66 202h94" stroke="#f97316" strokeWidth="12" strokeLinecap="round" />
    </svg>
  );
}
