import { describe, expect, it } from 'vitest';
import { clampPopoverShift } from './metric-info-clamp';

describe('clampPopoverShift', () => {
  // At a 320px viewport the pop's CSS caps its width to `100vw - 16px` (304px), so a
  // start-aligned popover (left: 0) rendered at the left edge of a narrow card already fits and
  // needs no shift.
  it('leaves a start-aligned popover that already fits untouched', () => {
    expect(clampPopoverShift({ left: 8, right: 304 }, 320)).toBe(0);
  });

  // An end-aligned popover on a narrow (320px) viewport anchors to the card's right edge, so its
  // `right` can exceed the viewport — this is the case the mobile audit found clipping off-screen.
  it('shifts an end-aligned popover left until it clears the right inset', () => {
    // Card sits near the right edge: pop occupies [96, 328] before clamping.
    expect(clampPopoverShift({ left: 96, right: 328 }, 320)).toBe(-16);
  });

  // The left-edge clamp must win over the right-edge clamp when both would fire, so a popover
  // wider than the available space never gets pushed past the left inset while chasing the right
  // one — matches the pop's `max-width: min(320px, calc(100vw - 16px))` CSS guarantee.
  it('prioritizes the left clamp when both edges would otherwise clip', () => {
    // Popover (340px) is wider than the 320px viewport's 304px (100vw - 16) budget, so both edge
    // checks genuinely fire: the right clamp alone would want dx=-18, but the left clamp then
    // overrides it entirely, landing on 18.
    const rect = { left: -10, right: 330 };
    const vw = 320;
    expect(rect.right > vw - 8).toBe(true); // right-edge clamp condition fires
    expect(rect.left + (vw - 8 - rect.right) < 8).toBe(true); // left-edge clamp condition also fires
    expect(clampPopoverShift(rect, vw)).toBe(18);
  });

  it('is a no-op for a centered popover with room on both sides', () => {
    expect(clampPopoverShift({ left: 40, right: 280 }, 320)).toBe(0);
  });
});
