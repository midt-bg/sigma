import type { ReactNode } from 'react';
import type { OwnershipKind } from '@sigma/api-contract';
import { pct } from '@sigma/shared';

// Small editorial primitives shared across pages. Class definitions live in app.css (ported verbatim
// from the mock); these just emit the markup.

export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}

const REGISTRY_URL = 'https://portal.registryagency.bg/CR/bg/Reports/ActiveConditionTabResult';

export function ExternalEikLink({ eik, className }: { eik: string; className?: string }) {
  return (
    <a
      href={`${REGISTRY_URL}?uic=${encodeURIComponent(eik)}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`external-eik-link${className ? ` ${className}` : ''}`}
      aria-label={`Отвори ЕИК ${eik} в Търговския регистър (в нов раздел)`}
      title="Отвори в Търговския регистър (в нов раздел)"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </a>
  );
}

const OWNERSHIP_LABELS: Record<OwnershipKind, string> = {
  state: 'държавно',
  municipal: 'общинско',
  mixed: 'държавно-общинско',
};

export function OwnershipChip({ kind }: { kind: OwnershipKind | null | undefined }) {
  if (!kind) return null;
  return <Chip>{OWNERSHIP_LABELS[kind]}</Chip>;
}

export function Flag({
  children,
  variant,
}: {
  children: ReactNode;
  variant?: 'soft' | 'info' | 'neutral';
}) {
  return <span className={`flag${variant ? ` ${variant}` : ''}`}>{children}</span>;
}

// Inline percentage bar. `warn` paints the fill in the accent red (e.g. a dominant share).
export function ShareBar({ ratio, warn }: { ratio: number; warn?: boolean }) {
  const width = `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%`;
  return (
    <span className="share">
      <span className={`share-bar${warn ? ' warn' : ''}`} aria-hidden="true">
        <i style={{ width }} />
      </span>
      <span className="share-num">
        {pct(ratio)}
        {warn && <span className="sr-only"> — висок дял</span>}
      </span>
    </span>
  );
}

export function Callout({
  title,
  variant,
  children,
}: {
  title?: ReactNode;
  variant?: 'warning';
  children: ReactNode;
}) {
  return (
    <div className={`callout${variant ? ` ${variant}` : ''}`}>
      {title != null && <h3>{title}</h3>}
      {children}
    </div>
  );
}

// A titled content section (ink-rule h2 + optional hint). The title may carry an <em> accent.
export function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {hint != null && <p className="section-hint">{hint}</p>}
      {children}
    </section>
  );
}
