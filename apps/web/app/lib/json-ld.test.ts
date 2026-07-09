import { describe, expect, it } from 'vitest';
import { jsonLdScript } from './json-ld';

const LS = String.fromCharCode(0x2028); // U+2028 line separator
const PS = String.fromCharCode(0x2029); // U+2029 paragraph separator

describe('jsonLdScript', () => {
  it('escapes < so a string value cannot close the <script> element', () => {
    const out = jsonLdScript({ url: 'https://x/</script><script>alert(1)</script>' });
    // The raw breakout sequence must not survive — this is the whole point of the sink.
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('\\u003c/script');
  });

  it('is JSON-equivalent: parsing the output returns the identical value', () => {
    const value = {
      name: 'A </script> B',
      nested: ['<a>', { k: '</SCRIPT >' }],
      n: 42,
    };
    expect(JSON.parse(jsonLdScript(value))).toEqual(value);
  });

  it('escapes the U+2028 / U+2029 line/paragraph separators', () => {
    const value = { s: `a${LS}b${PS}c` };
    const out = jsonLdScript(value);
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    expect(out).not.toContain(LS);
    expect(out).not.toContain(PS);
    // Still round-trips to the original value.
    expect(JSON.parse(out)).toEqual(value);
  });

  it('leaves injection-free content byte-identical to JSON.stringify', () => {
    const value = { '@context': 'https://schema.org', name: 'СИГМА', url: 'https://sigma.midt.bg' };
    expect(jsonLdScript(value)).toBe(JSON.stringify(value));
  });

  it('returns valid JSON (not a throw) for values that stringify to undefined', () => {
    // JSON.stringify(undefined | function | symbol) === undefined; the helper must not call .replace
    // on it. Emitting "null" keeps the <script> body parseable.
    expect(jsonLdScript(undefined)).toBe('null');
    expect(jsonLdScript(() => 1)).toBe('null');
    expect(JSON.parse(jsonLdScript(undefined))).toBeNull();
  });
});
