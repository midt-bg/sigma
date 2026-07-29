import { describe, expect, it } from 'vitest';
import { serializeJsonForScript } from './json-ld';

const LS = String.fromCharCode(0x2028); // U+2028 line separator
const PS = String.fromCharCode(0x2029); // U+2029 paragraph separator

describe('serializeJsonForScript', () => {
  it('escapes < so a string value cannot close the <script> element', () => {
    const out = serializeJsonForScript({ url: 'https://x/</script><script>alert(1)</script>' });
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
    expect(JSON.parse(serializeJsonForScript(value))).toEqual(value);
  });

  it('escapes the U+2028 / U+2029 line/paragraph separators', () => {
    const value = { s: `a${LS}b${PS}c` };
    const out = serializeJsonForScript(value);
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    expect(out).not.toContain(LS);
    expect(out).not.toContain(PS);
    // Still round-trips to the original value.
    expect(JSON.parse(out)).toEqual(value);
  });

  it('leaves injection-free content byte-identical to JSON.stringify', () => {
    const value = { '@context': 'https://schema.org', name: 'СИГМА', url: 'https://sigma.midt.bg' };
    expect(serializeJsonForScript(value)).toBe(JSON.stringify(value));
  });

  it('does NOT escape > or & (only < can break out of a script raw-text context)', () => {
    const out = serializeJsonForScript({ s: 'a > b && c' });
    expect(out).toContain('a > b && c'); // left verbatim, byte-minimal
    expect(out).not.toContain('&amp;');
    expect(out).not.toContain('&gt;');
  });

  it('returns valid JSON (not a throw) for values that stringify to undefined', () => {
    // JSON.stringify(undefined | function | symbol) === undefined; the helper must not call .replace
    // on it. Emitting "null" keeps the <script> body parseable.
    expect(serializeJsonForScript(undefined)).toBe('null');
    expect(serializeJsonForScript(() => 1)).toBe('null');
    expect(JSON.parse(serializeJsonForScript(undefined))).toBeNull();
  });
});
