import { describe, expect, it } from 'vitest';
import { errorText, MAX_LOG_MESSAGE_CHARS } from './log-safety';

describe('errorText', () => {
  it('returns an Error message WITHOUT the stack or the cause chain', () => {
    const cause = new Error('вътрешна причина с текста на въпроса');
    const err = new Error('заявката се провали', { cause });
    const out = errorText(err);
    expect(out).toBe('заявката се провали');
    // The leak vectors this helper exists to close: stack frames and the cause's message must not
    // reach the log line (logging the raw object would have carried both).
    expect(out).not.toContain('вътрешна причина');
    expect(out).not.toContain('at ');
  });

  it('stringifies non-Error throws without exposing object internals', () => {
    expect(errorText('плосък низ')).toBe('плосък низ');
    expect(errorText(undefined)).toBe('undefined');
    expect(errorText(null)).toBe('null');
    // An object throw collapses to the opaque tag, not its (possibly question-bearing) fields.
    expect(errorText({ query: 'обща сума на договорите на X' })).toBe('[object Object]');
  });

  it('caps an oversized provider message so one log line cannot blow up', () => {
    const out = errorText(new Error('x'.repeat(MAX_LOG_MESSAGE_CHARS + 500)));
    expect(out).toHaveLength(MAX_LOG_MESSAGE_CHARS + 1); // + the ellipsis
    expect(out.endsWith('…')).toBe(true);
  });
});
