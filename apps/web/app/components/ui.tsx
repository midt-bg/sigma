import type { ReactNode } from 'react';
import type { OwnershipKind } from '@sigma/api-contract';
import { pct } from '@sigma/shared';

// Small editorial primitives shared across pages. Class definitions live in app.css (ported verbatim
// from the mock); these just emit the markup.

export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}

export function ExternalEikLink({ eik, className }: { eik: string; className?: string }) {
  return (
    <a
      href={`https://portal.registryagency.bg/CR/bg/Reports/ActiveConditionTabResult?uic=${eik}`}
      target="_blank"
      rel="noopener noreferrer"
      className={className ? `external-eik-link ${className}` : 'external-eik-link'}
      title="Отвори в Търговския регистър"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '2px',
        marginLeft: '6px',
        color: 'inherit',
        textDecoration: 'none',
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
        style={{ opacity: 0.7 }}
      >
        <path d="M3.5 1.75H9l3.5 3.5v9h-9z" />
        <path d="M9 1.75V5.25h3.5" />
      </svg>
      <span
        className="cta-ext"
        aria-hidden="true"
        style={{ fontSize: '10px', opacity: 0.7, transform: 'translateY(-2px)' }}
      >
        ↗
      </span>
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
