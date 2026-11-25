export function LogoMark({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <path
        d="M9 15.4 16 9.5l7 5.9v6.6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 9 22z"
        fill="none"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="18.2" r="2" fill="#fff" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-2 text-ink">
      <LogoMark />
      <span className="hidden text-[19px] font-semibold tracking-[-0.03em] md:inline">housewatch</span>
    </span>
  );
}
