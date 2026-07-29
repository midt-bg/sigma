// Minimal safe markdown renderer for report text/callout blocks (spec §D3 / §7) and assistant dock prose.
//
// Contract obligations:
//  • No dangerouslySetInnerHTML — prose is rendered as React elements only.
//  • No raw-HTML passthrough — the tokenizer does not parse or emit HTML tags.
//  • Link href allowlist — sanitizeLinkHref(href) is the gate; unsafe hrefs degrade to plain text.
//
// Inline: **bold**, *italic*, `inline code`, [text](url). Nested emphasis is intentionally not supported.
// Block:  paragraphs (blank-line separated), unordered/ordered lists, horizontal rules, and GFM pipe
//         tables. Tables REQUIRE the delimiter row (`| --- |`) so a stray `|` in prose is not misparsed.
//         Nested lists, multi-line cells, escaped `\|`, and `#` headings are out of scope (YAGNI).

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

// Block-level line predicates. Module-scope (stable references, no shared lastIndex).
const isUl = (l: string): boolean => /^\s*[-*]\s+/.test(l);
const isOl = (l: string): boolean => /^\s*\d+\.\s+/.test(l);
// A whole line of 3+ identical `-`/`*`/`_` — a horizontal rule. Never has pipes (distinguishes from a
// table delimiter row).
const isHr = (l: string): boolean => /^\s*([-*_])\1{2,}\s*$/.test(l);
// A pipe row: starts and ends with `|`.
const isRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
// A GFM delimiter row (`| --- | :--: |`): only pipes/dashes/colons/space, with at least one dash and one
// pipe. The `includes` short-circuits keep this linear on adversarial `|`-floods / `-`-floods (no ReDoS).
const isDelim = (l: string): boolean => {
  const t = l.trim();
  return t.includes('|') && t.includes('-') && /^[\s|:-]+$/.test(t);
};
// Split a pipe row into trimmed cells, dropping the leading/trailing border pipes.
const splitRow = (l: string): string[] =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

// A pipe row that is followed by a delimiter row starts a table. Bounds-checked: a row that is the LAST
// line (streaming partial table) must NOT dereference lines[i+1].
const startsTable = (lines: string[], i: number): boolean =>
  isRow(lines[i]) && i + 1 < lines.length && isDelim(lines[i + 1]);

/** Parse markdown into an ordered list of block elements. Every text fragment flows through renderInline. */
function renderBlocks(md: string): ReactNode[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    if (isHr(line)) {
      blocks.push(<hr key={key++} />);
      i++;
      continue;
    }

    if (startsTable(lines, i)) {
      const header = splitRow(line);
      i += 2; // skip header + delimiter
      const rows: string[][] = [];
      while (i < lines.length && isRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <table key={key++}>
          <thead>
            <tr>
              {header.map((c, ci) => (
                <th key={ci}>{renderInline(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((c, ci) => (
                  <td key={ci}>{renderInline(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    if (isUl(line)) {
      const items: string[] = [];
      while (i < lines.length && isUl(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (isOl(line)) {
      const items: string[] = [];
      while (i < lines.length && isOl(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++}>
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph: accumulate consecutive lines until a blank line or any block-form boundary.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !isHr(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i]) &&
      !startsTable(lines, i)
    ) {
      para.push(lines[i]);
      i++;
    }
    const text = para.join('\n').trim();
    if (text) blocks.push(<p key={key++}>{renderInline(text)}</p>);
  }

  return blocks;
}

interface MarkdownBlockProps {
  /** Markdown prose. Report text is server-sanitized (sanitizeProse); dock prose is raw model output —
   * safe either way (no raw-HTML passthrough, link hrefs gated). */
  md: string;
  className?: string;
}

/**
 * Renders markdown prose as React elements.
 * No dangerouslySetInnerHTML, no raw-HTML passthrough, link hrefs gated by sanitizeLinkHref.
 */
export function MarkdownBlock({ md, className }: MarkdownBlockProps) {
  const blocks = renderBlocks(md);
  if (blocks.length === 0) return null;
  return <div className={className}>{blocks}</div>;
}
