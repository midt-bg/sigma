import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clampPopoverShift } from './metric-info-clamp';

// useLayoutEffect warns "does nothing on the server" under SSR; fall back to useEffect there since
// there is no layout to read/flush before paint on the server anyway.
const useIsoLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect;

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
  // Mirrors `shift` synchronously so `recompute` always reads the value actually applied to the
  // DOM right now, not a stale render closure — see the idempotency note in `recompute` below.
  const shiftRef = useRef(0);
  // Keyboard focus (no click) also reveals the popover via CSS `:focus-within`; track it so
  // `aria-expanded` matches what's actually visible, not just the click-toggled `open` state.
  const [focused, setFocused] = useState(false);
  // Mouse hover also reveals the popover via CSS `:hover` — track it for the same reason, and so
  // Esc can dismiss a hover-only-opened popover (ARIA tooltip pattern: Esc closes it regardless
  // of which trigger revealed it).
  const [hovered, setHovered] = useState(false);
  // Force-hides the popover (via the `is-dismissed` CSS override) after Esc, even while the mouse
  // is still hovering or the trigger still has focus. Clears once the trigger state that caused it
  // to show goes away, so the popover can reopen normally afterward.
  const [dismissed, setDismissed] = useState(false);
  const wouldBeVisible = open || focused || hovered;
  const visible = wouldBeVisible && !dismissed;

  useIsoLayoutEffect(() => {
    if (!visible) {
      shiftRef.current = 0;
      setShift(0);
      return;
    }
    const pop = popRef.current;
    const recompute = () => {
      if (!pop) return;
      // getBoundingClientRect() reflects the *currently applied* `translate`, so subtract the
      // shift already in effect to recover the popover's unshifted natural position before
      // clamping again — otherwise each recompute clamps an already-shifted rect and a
      // resize/scroll can cancel or compound the previous shift instead of converging.
      const rect = pop.getBoundingClientRect();
      const naturalRect = {
        left: rect.left - shiftRef.current,
        right: rect.right - shiftRef.current,
      };
      const vw = document.documentElement.clientWidth;
      const next = clampPopoverShift(naturalRect, vw);
      shiftRef.current = next;
      setShift(next);
    };
    recompute();
    if (!pop) return;
    // Re-clamp on resize/scroll while visible (click, hover, or keyboard focus) so the popover
    // can't drift out of the viewport; rAF coalesces bursts of scroll events into at most one
    // recompute per frame.
    let raf = 0;
    const onViewportChange = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [visible]);

  // Close on outside-click while open (touch path — pointer users rely on CSS hover/focus).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  // Esc closes the popover whenever it's visible — via click-open, keyboard focus, or mouse hover
  // — not just the click-toggled `open` state. Blurring the active element also drops CSS
  // `:focus-within`, and `dismissed` overrides `:hover` until the pointer actually leaves.
  useEffect(() => {
    if (!wouldBeVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      setDismissed(true);
      // Only blur if focus is actually inside this popover's trigger — otherwise a hover-only
      // dismiss here would steal focus from an unrelated input elsewhere on the page.
      const active = document.activeElement;
      if (active instanceof HTMLElement && ref.current?.contains(active)) active.blur();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [wouldBeVisible]);

  // Once every trigger that made the popover visible has cleared, drop the dismissal so hovering
  // or focusing again reopens it normally.
  useEffect(() => {
    if (!wouldBeVisible && dismissed) setDismissed(false);
  }, [wouldBeVisible, dismissed]);

  return (
    <span
      className={`metric-info${open ? ' is-open' : ''}${dismissed ? ' is-dismissed' : ''}`}
      ref={ref}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className="metric-info-btn"
        aria-label={aria}
        aria-expanded={visible}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
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
