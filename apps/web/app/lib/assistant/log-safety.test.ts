import { describe, expect, it } from 'vitest';
import { errorText, MAX_LOG_MESSAGE_CHARS, stackHead } from './log-safety';

describe('errorText', () => {
  it('returns the message without the stack or the cause chain', () => {
    const err = new Error('заявката се провали', { cause: new Error('вътрешна причина') });
    const out = errorText(err);
    expect(out).toBe('заявката се провали');
    expect(out).not.toContain('вътрешна причина');
    expect(out).not.toContain('at ');
  });

  it('NEVER throws — a value that cannot be stringified degrades to a fixed tag', () => {
    // The load-bearing property: this runs inside catch blocks whose job is graceful degradation.
    // A throw here would escape the catch and turn a handled fallback into an unhandled 500 (and
    // hand the raw envelope to the framework logger — the opposite of the intent).
    // Verified throwing inputs: a null-prototype object has no toString; a Proxy can throw from a trap.
    expect(errorText(Object.create(null))).toBe('«грешка без текстово представяне»');
    expect(
      errorText(
        new Proxy(
          {},
          {
            get() {
              throw new Error('trap');
            },
          },
        ),
      ),
    ).toBe('«грешка без текстово представяне»');
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('getter');
      },
    });
    expect(errorText(hostile)).toBe('«грешка без текстово представяне»');
  });

  it('redacts a known input that the provider echoed back into the message', () => {
    // This — not the stack-drop — is what actually closes "the error echoed the question". The
    // call sites that hold the input (route: the question; semantic_search: the query) pass it in.
    const question = 'колко е платила община Пловдив на фирма Х';
    const err = new Error(`invalid input: ${question} (code 400)`);
    const out = errorText(err, [question]);
    expect(out).not.toContain('Пловдив');
    expect(out).toContain('«редактирано»');
    expect(out).toContain('code 400'); // the diagnostic survives
  });

  it('ignores too-short redaction needles instead of shredding the message', () => {
    const out = errorText(new Error('no such column: eik'), ['eik']);
    expect(out).toBe('no such column: eik');
  });

  it('collapses a multi-line message to one line (prefix-keyed greps must not lose the tail)', () => {
    expect(errorText(new Error('ред 1\n  ред 2\tред 3'))).toBe('ред 1 ред 2 ред 3');
  });

  it('stringifies non-Error throws, INCLUDING a custom toString (documents the real behaviour)', () => {
    expect(errorText('плосък низ')).toBe('плосък низ');
    expect(errorText(undefined)).toBe('undefined');
    expect(errorText(null)).toBe('null');
    expect(errorText({ q: 'нещо' })).toBe('[object Object]');
    // NOT an "opaque tag" guarantee: an object with its own toString is emitted verbatim, which is
    // precisely why redaction (above), not stringification, is the mitigation for echoed input.
    expect(errorText({ toString: () => 'q=обща сума' })).toBe('q=обща сума');
  });

  it('caps by code points, so truncation cannot split an emoji into a lone surrogate', () => {
    const out = errorText(new Error('x'.repeat(MAX_LOG_MESSAGE_CHARS) + '😀'));
    expect(Array.from(out)).toHaveLength(MAX_LOG_MESSAGE_CHARS + 1); // + the ellipsis
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no unpaired high surrogate
  });
});

describe('stackHead', () => {
  it('returns leading frames only — locations, never the message or user text', () => {
    const out = stackHead(new Error('съобщение с въпроса вътре'), 2);
    expect(out).not.toContain('съобщение с въпроса');
    expect(out.length).toBeGreaterThan(0);
    expect(out.split(' | ').length).toBeLessThanOrEqual(2);
  });

  it('returns an empty string for a non-Error or a stackless Error', () => {
    expect(stackHead('низ')).toBe('');
    const noStack = new Error('x');
    Object.defineProperty(noStack, 'stack', { value: undefined });
    expect(stackHead(noStack)).toBe('');
  });
});
