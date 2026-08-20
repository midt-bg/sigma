import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import WeeksIndex from './weeks._index';

// loaderData is the client-safe shape the loader returns: the R2-derived week index.
// W25 carries Mon–Sun dates (the human range label); W24 has none (older artifact → iso fallback).
const loaderData = {
  weeks: [
    { iso: '2026-W25', monday: '2026-06-15', sunday: '2026-06-21', totalEur: 3_656_000 },
    { iso: '2026-W24', monday: null, sunday: null, totalEur: null },
  ],
};

function render(): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(WeeksIndex, { loaderData } as never)),
  );
}

describe('/weeks archive', () => {
  const html = render();

  it('links each week to its digest page', () => {
    expect(html).toContain('href="/weeks/2026-W25"');
    expect(html).toContain('href="/weeks/2026-W24"');
  });

  it('makes the whole row clickable via the row-link stretched-link pattern', () => {
    // Every data row carries `row-link`; the CSS stretches the title-cell anchor across the row.
    expect(html).toContain('class="row-link"');
    // Two data rows → two row-link rows (header row is not one).
    expect(html.match(/class="row-link"/g)?.length).toBe(2);
  });

  it('shows the total, and an em-dash when a week has no total', () => {
    expect(html).toContain('—'); // 2026-W24 has null totalEur
  });

  it('labels a week by its Mon–Sun date range, falling back to the iso when dates are absent', () => {
    // W25 has dates → human range (the link text, not the href).
    expect(html).toContain('15.06.2026 – 21.06.2026');
    // The iso is no longer the visible label for a dated week…
    expect(html).not.toContain('>2026-W25<');
    // …but W24 (no dates) still falls back to the iso as its label.
    expect(html).toContain('>2026-W24<');
  });
});
