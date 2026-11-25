// The link to СИГМА Бюджет, the sister site: in the footer only while its address is set, and opened in a
// new tab that says so to a screen reader.
import { renderToString } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from './SiteFooter';

function render(footer: React.ReactElement): string {
  const router = createMemoryRouter([{ path: '*', Component: () => footer }]);
  return renderToString(<RouterProvider router={router} />);
}

function footerHtml(budgetUrl?: string | null): string {
  return render(<SiteFooter budgetUrl={budgetUrl} />);
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

describe('SiteFooter — figures unavailable', () => {
  const figures = { asOf: '2000-03-04', refreshedAt: '2000-03-05 06:07:08', endYear: 2000 };
  const text = (html: string) => html.replace(/<[^>]+>/g, '');
  const links = (html: string) => html.slice(html.indexOf('<ul'));

  it('shows the source, range and dates when they were read', () => {
    expect(text(render(<SiteFooter {...figures} />))).toContain(
      '(storage.eop.bg) · 2020–\u20602000 · последен договор 04.03.2000 · данни обновени 05.03.2000',
    );
  });

  it('says the figures are temporarily unavailable instead of showing a guessed range', () => {
    const html = render(<SiteFooter unavailable budgetUrl="https://budget.example.bg" />);
    expect(text(html)).toContain(
      '(storage.eop.bg) · обхватът и датите на данните временно не са налични',
    );
    expect(text(html)).not.toMatch(/2020–|последен договор|данни обновени/);
  });

  it('changes only that one line: the same element and the same links', () => {
    const full = render(<SiteFooter {...figures} budgetUrl="https://budget.example.bg" />);
    const partial = render(<SiteFooter unavailable budgetUrl="https://budget.example.bg" />);
    expect(links(partial)).toBe(links(full));
    // Elements only: React's text-node separators (<!-- -->) differ with the number of text parts.
    const shape = (html: string) =>
      html
        .slice(0, html.indexOf('<ul'))
        .replace(/<!-- -->/g, '')
        .replace(/>[^<]*</g, '><');
    expect(shape(partial)).toBe(shape(full));
  });
});
