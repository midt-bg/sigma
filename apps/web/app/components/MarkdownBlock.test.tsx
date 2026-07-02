import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarkdownBlock } from './MarkdownBlock';

afterEach(() => {
  cleanup();
});

describe('MarkdownBlock — XSS safety (no dangerouslySetInnerHTML, no raw-HTML passthrough)', () => {
  it('renders bold, italic, and code as React elements', () => {
    const { container } = render(<MarkdownBlock md="**bold** *italic* `code`" />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('code')?.textContent).toBe('code');
  });

  it('does not inject raw HTML — angle brackets are text, not tags', () => {
    const { container } = render(<MarkdownBlock md="<script>alert(1)</script> hello" />);
    // The literal string must appear as text — no live <script> element.
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders safe https: links as anchors', () => {
    render(<MarkdownBlock md="[example](https://example.com)" />);
    const a = screen.getByRole('link', { name: 'example' });
    expect(a).toBeInTheDocument();
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('degrades javascript: href to plain text — no anchor rendered', () => {
    const { container } = render(<MarkdownBlock md="[click me](javascript:alert(1))" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('click me');
  });

  it('degrades data: href to plain text', () => {
    const { container } = render(<MarkdownBlock md="[xss](data:text/html,<h1>xss</h1>)" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('xss');
  });

  it('degrades protocol-relative // href to plain text', () => {
    const { container } = render(<MarkdownBlock md="[evil](//evil.com)" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('evil');
  });

  it('renders relative paths as anchors', () => {
    render(<MarkdownBlock md="[report](/reports/r_abc123)" />);
    const a = screen.getByRole('link', { name: 'report' });
    expect(a.getAttribute('href')).toBe('/reports/r_abc123');
  });

  it('splits on blank lines into paragraphs', () => {
    const { container } = render(<MarkdownBlock md={'paragraph one\n\nparagraph two'} />);
    const paras = container.querySelectorAll('p');
    expect(paras).toHaveLength(2);
    expect(paras[0].textContent).toBe('paragraph one');
    expect(paras[1].textContent).toBe('paragraph two');
  });

  it('returns null for empty / whitespace-only input', () => {
    const { container } = render(<MarkdownBlock md="   " />);
    expect(container.firstChild).toBeNull();
  });
});
