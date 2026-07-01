// Minimal safe markdown renderer for report text/callout blocks (spec §D3 / §7).
//
// Contract obligations:
//  • No dangerouslySetInnerHTML — server-sanitized prose is rendered as React elements only.
//  • No raw-HTML passthrough — the tokenizer does not parse or emit HTML tags.
//  • Link href allowlist — sanitizeLinkHref(href) is the gate; unsafe hrefs degrade to plain text.
//
// Supports: **bold**, *italic*, `inline code`, [text](url), and paragraph splitting on blank lines.
// Nested emphasis is intentionally not supported (model output does not produce it and recursive
// backtracking would be complex; a future upgrade can add it without breaking this interface).

import type { ReactNode } from 'react';
import { sanitizeLinkHref } from '~/lib/sanitize-markdown';

// Single-pass inline tokenizer. Each capturing group corresponds to one inline form:
//   m[1]/m[2] → **bold** / inner text
//   m[3]/m[4] → *italic* / inner text
//   m[5]/m[6] → `code` / inner text
//   m[7]/m[8] → [link text](url) / text / href
// The `(?!\*)` look-ahead on *italic* prevents matching `**` as two italic markers.
// Regex is created inside renderInline (not at module scope) to avoid shared mutable lastIndex state.

function renderInline(text: string): ReactNode[] {
  const INLINE_RE =
    /(\*\*([^*]+)\*\*)|(\*(?!\*)([^*]+)\*(?!\*))|(`([^`]+)`)|\[([^\]]*)\]\(([^)]*)\)/g;
  const nodes: ReactNode[] = [];
  let pos = 0;
  let key = 0;
  let m: RegExpExecArray | null;

  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > pos) nodes.push(text.slice(pos, m.index));
    const k = key++;

    if (m[1] !== undefined) {
      nodes.push(<strong key={k}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      nodes.push(<em key={k}>{m[4]}</em>);
    } else if (m[5] !== undefined) {
      nodes.push(<code key={k}>{m[6]}</code>);
    } else {
      const linkText = m[7] ?? '';
      const safeHref = sanitizeLinkHref(m[8] ?? '');
      if (safeHref !== null) {
        nodes.push(
          <a key={k} href={safeHref} target="_blank" rel="noopener noreferrer">
            {linkText}
          </a>,
        );
      } else {
        // Unsafe href: render the link text as plain text — never a dead/harmful link.
        nodes.push(<span key={k}>{linkText}</span>);
      }
    }

    pos = INLINE_RE.lastIndex;
  }

  if (pos < text.length) nodes.push(text.slice(pos));
  return nodes;
}

interface MarkdownBlockProps {
  /** Server-sanitized markdown prose (HTML already stripped by sanitizeProse). */
  md: string;
  className?: string;
}

/**
 * Renders server-sanitized report markdown as React elements.
 * No dangerouslySetInnerHTML, no raw-HTML passthrough, link hrefs gated by sanitizeLinkHref.
 */
export function MarkdownBlock({ md, className }: MarkdownBlockProps) {
  const paragraphs = md
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return null;

  return (
    <div className={className}>
      {paragraphs.map((para, idx) => (
        <p key={idx}>{renderInline(para)}</p>
      ))}
    </div>
  );
}
