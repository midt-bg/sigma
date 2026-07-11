// Pure clamp math, split out of MetricInfo.tsx so it's unit-testable without a DOM/JSX transform:
// how far (px) to shift the popover so it stays within an 8px inset of the viewport on both
// edges. Narrow viewports (e.g. 320px) can trigger both the right-edge and left-edge clamps in
// the same computation when the popover is wider than the available space — the left clamp
// always wins in that case, matching the pop's `max-width: min(320px, calc(100vw - 16px))` CSS,
// which guarantees the popover itself never exceeds `viewportWidth - 16`.
export function clampPopoverShift(rect: { left: number; right: number }, viewportWidth: number): number {
  let dx = 0;
  if (rect.right > viewportWidth - 8) dx = viewportWidth - 8 - rect.right;
  if (rect.left + dx < 8) dx = 8 - rect.left;
  return Math.round(dx);
}
