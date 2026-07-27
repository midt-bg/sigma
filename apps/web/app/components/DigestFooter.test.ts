import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DigestFooter } from './DigestFooter';

function render(props: Parameters<typeof DigestFooter>[0]): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(DigestFooter, props)),
  );
}

describe('DigestFooter', () => {
  it('states the source license and that the digest is auto-generated', () => {
    const html = render({});
    expect(html).toContain('CC-BY 4.0');
    expect(html).toContain('генерирано автоматично');
  });

  it('links back to the archive', () => {
    const html = render({});
    expect(html).toContain('href="/weeks"');
  });

  it('shows the data freshness date when provided', () => {
    const html = render({ asOf: '2026-06-18' });
    expect(html).toContain('данни към 18.06.2026');
  });

  it('shows a correction note only when the week was re-issued', () => {
    expect(render({})).not.toContain('коригирано');
    expect(render({ refreshedAt: '2026-06-20' })).toContain('коригирано на 20.06.2026');
  });
});
