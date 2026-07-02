import { useEffect, useRef, useState } from 'react';

// A small ⓘ affordance next to a metric label. For pointer users it reveals an elegant popover on
// hover or keyboard focus (pure CSS `:hover` / `:focus-within`). Because hover does not exist on
// touch, a click also toggles the popover open via an `is-open` class — and an outside-click or Esc
// closes it again. The button carries the full text as its aria-label, so screen-reader users get the
// same information without the visual popover (which is aria-hidden). SSR-safe: the initial render is
// closed and the toggle/effects only run on the client.
export function MetricInfo({
  title,
  summary,
  readout,
  align = 'start',
}: {
  title: string;
  summary: string;
  // Plain string so the readout is always reflected verbatim into the aria-label (all callers pass a
  // string — the screen-reader text must never silently drop a non-string interpretation).
  readout?: string;
  // Which edge the popover anchors to — use 'end' for right-most metrics so it doesn't clip.
  align?: 'start' | 'end';
}) {
  const aria = readout ? `${title}. ${summary} ${readout}`.trim() : `${title}. ${summary}`;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // Close on outside-click / Esc while open (touch path — pointer users rely on CSS hover/focus).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className={`metric-info${open ? ' is-open' : ''}`} ref={ref}>
      <button
        type="button"
        className="metric-info-btn"
        aria-label={aria}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="metric-info-glyph" aria-hidden="true">
          ⓘ
        </span>
      </button>
      <span className={`metric-info-pop${align === 'end' ? ' is-end' : ''}`} aria-hidden="true">
        <span className="metric-info-title">{title}</span>
        <span className="metric-info-summary">{summary}</span>
        {readout ? <span className="metric-info-readout">{readout}</span> : null}
      </span>
    </span>
  );
}
