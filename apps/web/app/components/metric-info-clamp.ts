// Pure clamp math, split out of MetricInfo.tsx so it's unit-testable without a DOM/JSX transform:
// how far (px) to shift the popover so it stays within an 8px inset of the viewport on both
// edges. Narrow viewports (e.g. 320px) can trigger both the right-edge and left-edge clamps in
// the same computation when the popover is wider than the available space — the left clamp
// always wins in that case, matching the pop's `max-width: min(320px, calc(100vw - 16px))` CSS,
// which guarantees the popover itself never exceeds `viewportWidth - 16`.
// Must match the CSS `max-width: min(320px, calc(100vw - 16px))` inset — keep VIEWPORT_INSET_PX in
// sync with that `16px` (2×inset) if the popover's CSS inset ever changes.
const VIEWPORT_INSET_PX = 8;

export function clampPopoverShift(
  rect: { left: number; right: number },
  viewportWidth: number,
): number {
  let dx = 0;
  if (rect.right > viewportWidth - VIEWPORT_INSET_PX)
    dx = viewportWidth - VIEWPORT_INSET_PX - rect.right;
  if (rect.left + dx < VIEWPORT_INSET_PX) dx = VIEWPORT_INSET_PX - rect.left;
  return Math.round(dx);
}
