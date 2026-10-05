export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="4" y="2" width="22" height="28" rx="5" fill="var(--color-brand)" />
      <path d="M10 10h10M10 15h10M10 20h5" stroke="white" strokeWidth="2" strokeLinecap="round" />
      <circle cx="24" cy="23" r="6.5" fill="white" stroke="var(--color-brand)" strokeWidth="2" />
      <path
        d="m21.2 23 1.9 1.9 3.6-3.8"
        fill="none"
        stroke="var(--color-brand)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
