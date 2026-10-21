// The filter forms above the five visualisations submit with JavaScript. Without it the same form needs
// its own submit button, and a <form> with a name is already a landmark, so role="group" (not allowed
// on a form) would only hide that. All five go through the shared FilterForm, which carries both.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROUTES = ['flows', 'network', 'map', 'trends', 'competition'];
const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');

describe('FilterForm', () => {
  const src = read('../components/FilterForm.tsx');
  const form = src.slice(src.indexOf('<Form'), src.indexOf('</Form>'));
  it('has a submit button for readers without JavaScript', () => {
    expect(form).toMatch(/<noscript>\s*<button type="submit">Покажи<\/button>\s*<\/noscript>/);
  });
  it('keeps the form role', () => {
    expect(form).not.toContain('role=');
  });
});

describe.each(ROUTES)('/%s filter form', (route) => {
  it('is the shared FilterForm, not a form of its own', () => {
    const src = read(`${route}.tsx`);
    expect(src).toContain('<FilterForm');
    expect(src).not.toContain('<Form');
  });
});
