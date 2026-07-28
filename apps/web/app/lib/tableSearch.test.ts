import { describe, expect, it } from 'vitest';
import { isComposingAfter, shouldAdoptUrlQ, shouldSubmitLive } from './tableSearch';

describe('shouldAdoptUrlQ', () => {
  const settled = true;

  it('does not adopt when the field already matches the URL', () => {
    expect(shouldAdoptUrlQ({ urlQ: 'мост', value: 'мост', focused: false, settled })).toBe(false);
  });

  it('does not adopt while the field is focused (mid-edit)', () => {
    // The resync effect bails here so a late loader can't revert keystrokes.
    expect(shouldAdoptUrlQ({ urlQ: 'нов', value: 'стар', focused: true, settled })).toBe(false);
  });

  it('adopts external navigation once the field is blurred and settled', () => {
    // back/forward (or a filter link) changed q while the box held the old text — adopt on blur.
    expect(shouldAdoptUrlQ({ urlQ: 'нов', value: 'стар', focused: false, settled })).toBe(true);
  });

  it('does not clobber a value the user typed but has not finished debouncing', () => {
    // value is ahead of the URL because a live submit is still pending; let the debounce land it.
    expect(shouldAdoptUrlQ({ urlQ: '', value: 'мост', focused: false, settled: false })).toBe(
      false,
    );
  });
});

describe('shouldSubmitLive', () => {
  it('suppresses the submit while an IME composition is in flight', () => {
    // Guards the composingRef-stuck-true edge: every live submit is muted until composing clears.
    expect(shouldSubmitLive({ composing: true, debounced: 'мост', urlQ: '' })).toBe(false);
  });

  it('skips the echo of our own navigation (settled value equals the URL)', () => {
    expect(shouldSubmitLive({ composing: false, debounced: 'мост', urlQ: 'мост' })).toBe(false);
  });

  it('ignores surrounding whitespace when comparing to the URL', () => {
    expect(shouldSubmitLive({ composing: false, debounced: '  мост ', urlQ: 'мост' })).toBe(false);
  });

  it('submits when the settled value really differs from the URL', () => {
    expect(shouldSubmitLive({ composing: false, debounced: 'мост', urlQ: '' })).toBe(true);
  });

  it('does not submit a sub-threshold query (below the 2-char/searchable-term floor)', () => {
    // A lone letter (or bare punctuation) never yields FTS terms — don't navigate or write ?q= for it.
    expect(shouldSubmitLive({ composing: false, debounced: 'я', urlQ: '' })).toBe(false);
  });

  it('still submits clearing the field even though empty has no searchable terms', () => {
    expect(shouldSubmitLive({ composing: false, debounced: '', urlQ: 'мост' })).toBe(true);
  });
});

describe('isComposingAfter', () => {
  it('arms only on compositionstart; end/cancel/blur all disarm', () => {
    expect(isComposingAfter('start')).toBe(true);
    expect(isComposingAfter('end')).toBe(false);
    // compositioncancel and a mid-IME blur never fire compositionend — they must still disarm.
    expect(isComposingAfter('cancel')).toBe(false);
    expect(isComposingAfter('blur')).toBe(false);
  });
});
