// The link to СИГМА Бюджет, the sister site: in the footer only while its address is set, and opened in a
// new tab that says so to a screen reader.
import { renderToString } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from './SiteFooter';

function footerHtml(budgetUrl?: string | null): string {
  const router = createMemoryRouter([
    { path: '*', Component: () => <SiteFooter budgetUrl={budgetUrl} /> },
  ]);
  return renderToString(<RouterProvider router={router} />);
}

describe('SiteFooter — СИГМА Бюджет', () => {
  it('leaves the link out while the address is not set', () => {
    expect(footerHtml(null)).not.toContain('СИГМА Бюджет');
    expect(footerHtml(undefined)).not.toContain('sister-link');
  });

  it('links the sister site in a new tab once the address is set', () => {
    const html = footerHtml('https://budget.example.bg');
    expect(html).toMatch(
      /<a target="_blank" rel="noopener noreferrer" class="sister-link" href="https:\/\/budget\.example\.bg">СИГМА Бюджет<span class="sr-only"> \(в нов раздел\)<\/span><\/a>/,
    );
  });
});
