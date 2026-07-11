import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// useLayoutEffect warns when it runs during SSR ("does nothing on the server"). Swap in useEffect
// for the server render so the console stays clean; the client still gets the synchronous layout
// measurement it needs before paint.
const useIsomorphicLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect;

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
  const popRef = useRef<HTMLSpanElement>(null);
  // Horizontal shift (px) that keeps the click-opened popover inside the viewport on small screens
  // (mobile audit: at 320px the fixed-width popover clips off-screen for edge-column metrics).
  const [shift, setShift] = useState(0);

  useIsomorphicLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const pop = popRef.current;
    if (!pop) return;
    const recalc = () => {
      const rect = pop.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      let dx = 0;
      if (rect.right > vw - 8) dx = vw - 8 - rect.right;
      if (rect.left + dx < 8) dx = 8 - rect.left;
      setShift(Math.round(dx));
    };
    recalc();
    // Viewport can change while the popover is open (rotation, browser-chrome resize, scroll on
    // small screens) — recompute so the popover doesn't drift outside the viewport.
    window.addEventListener('resize', recalc);
    window.addEventListener('scroll', recalc, true);
    return () => {
      window.removeEventListener('resize', recalc);
      window.removeEventListener('scroll', recalc, true);
    };
  }, [open]);

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
      <span
        className={`metric-info-pop${align === 'end' ? ' is-end' : ''}`}
        aria-hidden="true"
        ref={popRef}
        // `translate` composes with the CSS `transform` reveal transition instead of replacing it
        style={shift !== 0 ? { translate: `${shift}px 0` } : undefined}
      >
        <span className="metric-info-title">{title}</span>
        <span className="metric-info-summary">{summary}</span>
        {readout ? <span className="metric-info-readout">{readout}</span> : null}
      </span>
    </span>
  );
}
