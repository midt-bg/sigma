// The filter forms above the five visualisations submit on change with JavaScript. Without it the
// same form needs its own submit button, and a <form> with a name is already a landmark, so
// role="group" (not allowed on a form) would only hide that.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES = ['flows', 'network', 'map', 'trends', 'competition'];
const form = (route: string) => {
  const src = readFileSync(resolve(__dirname, `${route}.tsx`), 'utf8');
  const start = src.indexOf('className="flow-controls"');
  return src.slice(src.lastIndexOf('<Form', start), src.indexOf('</Form>', start));
};

describe.each(ROUTES)('/%s filter form', (route) => {
  it('has a submit button for readers without JavaScript', () => {
    expect(form(route)).toMatch(
      /<noscript>\s*<button type="submit">Покажи<\/button>\s*<\/noscript>/,
    );
  });
  it('keeps the form role', () => {
    expect(form(route)).not.toContain('role=');
  });
});
