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

  it('still redacts a needle whose whitespace differs from the collapsed message (shift-enter question)', () => {
    // The message is collapsed to one line BEFORE matching; a needle typed with a newline, a tab or
    // a double space (composer shift-enter) would otherwise never match the echo it is meant to blank.
    const question = 'колко плати\nобщина Пловдив\t на  фирма Х';
    const out = errorText(new Error(`400 invalid input: ${question}`), [question]);
    expect(out).not.toContain('Пловдив');
    expect(out).toBe('400 invalid input: «редактирано»');
  });

  it('judges the length floor on the collapsed needle, so whitespace padding cannot lift a short one over it', () => {
    // 'eik' wrapped in 12 chars of whitespace is still 'eik' once collapsed — below the floor.
    const out = errorText(new Error('no such column: eik'), ['   \n\t  eik   \n  ']);
    expect(out).toBe('no such column: eik');
  });

  it('stays total when a non-string sneaks into redact (never throws inside a catch block)', () => {
    const bad = [undefined, 42, null] as unknown as string[];
    expect(errorText(new Error('x'.repeat(10)), bad)).toBe('x'.repeat(10));
  });

  it('redacts a JSON-escaped echo (a provider quoting the input inside a JSON error body)', () => {
    // The common provider shape: the raw body becomes `.message`; a `"` in the question arrives as
    // `\"` and a shift-enter newline as the two characters `\n` — neither is the verbatim needle.
    const question = 'колко плати община "Пловдив"\nна фирма Х за 2024';
    const body = JSON.stringify({ error: { message: `invalid input: ${question}` } });
    const out = errorText(new Error(body), [question]);
    expect(out).not.toContain('Пловдив');
    expect(out).toContain('«редактирано»');
    expect(out).toContain('invalid input'); // the diagnostic survives
  });

  it('redacts a TRUNCATED echo of a long input (the embed path caps what it sends)', () => {
    const question = `колко плати община Пловдив на фирма Х ${'и още текст '.repeat(200)}`;
    const echoed = question.slice(0, 2048); // what a provider would quote back
    const out = errorText(new Error(`3010: invalid input: ${echoed}`), [question]);
    expect(out).not.toContain('Пловдив');
    expect(out).toContain('3010: invalid input: «редактирано»');
  });

  it('blanks a long echoed question as ONE run, not a prefix of it', () => {
    // Pre-cap regression guard: the raw message is bounded before matching, so a needle must still
    // be blanked in full even when the message is longer than the bound.
    const question = `${'в'.repeat(100)} ${'община Пловдив '.repeat(1200)}`.trim();
    const out = errorText(new Error(`err: ${question}`), [question]);
    expect(out).not.toContain(question.slice(0, 40));
    expect(out).toBe('err: «редактирано»');
  });

  it('leaves an unrelated message untouched by the windowed matcher', () => {
    const question = 'колко плати община Пловдив на фирма Х за 2024 година';
    const msg = 'Асистентът временно не е достъпен: no such column: total_value';
    expect(errorText(new Error(msg), [question])).toBe(msg);
  });

  it('caps a multi-megabyte message to the same line as a short one (pre-cap is invisible)', () => {
    // No timing assertion (flaky in CI); the pre-cap's effect is that this completes in ms, and the
    // OUTPUT must be identical to the uncapped computation.
    const out = errorText(new Error('x'.repeat(4 << 20)));
    expect(out).toBe(`${'x'.repeat(MAX_LOG_MESSAGE_CHARS)}…`);
  });

  it('never emits a lone surrogate even when the raw pre-cap boundary falls inside an emoji', () => {
    for (const pad of [19199, 19198]) {
      const out = errorText(new Error(`${' '.repeat(pad)}😀 опашка`));
      expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
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

  it('never returns continuation lines of a MULTI-LINE message (V8 prints the whole message first)', () => {
    // The line the route logs is `${errorText(e, [question])} | ${stackHead(e)}` — if the message
    // spans lines, "drop line 0" would hand back the question that errorText just redacted.
    const question = 'колко плати община Пловдив на фирма Х';
    const err = new Error(`invalid input:\n${question}\n(code 400)`);
    const out = stackHead(err, 3);
    expect(out).not.toContain('Пловдив');
    expect(out).not.toContain('code 400');
    expect(out).toMatch(/^at /);
    expect(out.split(' | ').every((f) => f.startsWith('at '))).toBe(true);
  });

  it('fails CLOSED on a stack with no recognisable frame line (never the header)', () => {
    const err = new Error('съобщение с въпроса вътре');
    Object.defineProperty(err, 'stack', { value: 'Error: съобщение с въпроса вътре\nнещо друго' });
    expect(stackHead(err)).toBe('');
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'stack', {
      get() {
        throw new Error('getter');
      },
    });
    expect(stackHead(hostile)).toBe('');
  });
});
