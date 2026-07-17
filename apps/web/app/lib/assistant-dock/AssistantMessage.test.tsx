import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { AssistantMessage, messageText } from './AssistantMessage';

afterEach(() => {
  cleanup();
});

const message = (role: 'user' | 'assistant', ...texts: string[]): UIMessage =>
  ({ id: 'm1', role, parts: texts.map((text) => ({ type: 'text', text })) }) as UIMessage;

describe('AssistantMessage', () => {
  it('renders the concatenated text of a message', () => {
    render(<AssistantMessage message={message('assistant', 'Извличам ', 'данните…')} />);

    expect(screen.getByText('Извличам данните…')).toBeInTheDocument();
  });

  it('tags the message with its role', () => {
    render(<AssistantMessage message={message('user', 'Здравейте')} />);

    expect(screen.getByText('Здравейте').closest('[data-role]')).toHaveAttribute(
      'data-role',
      'user',
    );
  });

  it('renders nothing for a message with no text parts', () => {
    const { container } = render(
      <AssistantMessage message={{ id: 'm2', role: 'assistant', parts: [] } as UIMessage} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders assistant prose as markdown (bold + list), not literal syntax', () => {
    const { container } = render(
      <AssistantMessage message={message('assistant', '**важно**\n- едно\n- две')} />,
    );

    expect(container.querySelector('strong')?.textContent).toBe('важно');
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.textContent).not.toContain('**важно**');
  });

  it('renders USER echo as verbatim plain text — no markdown', () => {
    const { container } = render(<AssistantMessage message={message('user', 'a * b * c')} />);

    expect(container.querySelector('em')).toBeNull();
    expect(container.querySelector('.assistant-message__text')?.textContent).toBe('a * b * c');
  });

  it('does not run sanitizeProse on dock prose — angle-bracket placeholders stay visible', () => {
    const { container } = render(
      <AssistantMessage message={message('assistant', 'Полето <ЕИК> е задължително')} />,
    );

    expect(container.textContent).toContain('<ЕИК>');
  });

  it('renders raw HTML in assistant prose as inert text', () => {
    const { container } = render(
      <AssistantMessage message={message('assistant', '<script>alert(1)</script> здравей')} />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('drops a prose markdown table that precedes a tool part (layer-3 integrity invariant)', () => {
    // When the model narrates a table in prose and THEN emits a report, messageText returns only text
    // after the last tool part — so the (unverified, unbound) prose table is never surfaced; the bound
    // report card is. This is what keeps prose numbers off the report surface. (Lock it against regression.)
    const msg = {
      id: 'm3',
      role: 'assistant',
      parts: [
        { type: 'text', text: '| Изпълнител | Сума |\n| --- | --- |\n| X | 5 |' },
        { type: 'tool-emit_report', toolCallId: 't1', state: 'output-available' },
      ],
    } as unknown as UIMessage;

    expect(messageText(msg)).toBe('');

    const { container } = render(<AssistantMessage message={msg} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent ?? '').not.toContain('Изпълнител');
  });

  // The weak 27B sometimes narrates emit_report's output as a raw <report>…</report> pseudo-XML block in
  // a TEXT part. MarkdownBlock renders unknown tags as inert literal text, so without stripping the user
  // sees raw "<report>" tags in the dock (the reported bug). The bound report card renders from the tool
  // part; the leaked block must not surface.
  it('strips a leaked <report> block so raw tags never render in the dock', () => {
    const leaked =
      'Ето справката: <report format="table"><block>{"type":"table","rows":[["X","5"]]}</block></report>';
    expect(messageText(message('assistant', leaked))).toBe('Ето справката:');

    const { container } = render(<AssistantMessage message={message('assistant', leaked)} />);
    expect(container.textContent ?? '').not.toContain('<report');
    expect(container.textContent ?? '').not.toContain('block>');
    expect(container.textContent ?? '').toContain('Ето справката:');
  });

  it('strips a whole-part <tool_response>/<tool_call> echo (renders nothing)', () => {
    const echo = message('assistant', '<tool_response>{"reportId":"r_1"}</tool_response>');
    expect(messageText(echo)).toBe('');
    const { container } = render(<AssistantMessage message={echo} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('strips a dangling opener left by a mid-stream truncation', () => {
    // No closing tag (the stream was cut) — everything from the opener to end is noise.
    const truncated = message('assistant', 'Готово. <report format="table"><block>{"type":"tabl');
    expect(messageText(truncated)).toBe('Готово.');
  });

  it('does not over-strip: a bare word and a non-matching tag survive', () => {
    // Only `<report|tool_call|tool_response>` with a word boundary is markup. The bare word "report" (no
    // angle bracket) and an unrelated tag like "<reporting>" must pass through untouched. ("<ЕИК>" prose
    // is guarded above.)
    expect(messageText(message('assistant', 'Този report показва 5 договора.'))).toBe(
      'Този report показва 5 договора.',
    );
    expect(messageText(message('assistant', 'Виж <reporting> раздела.'))).toBe(
      'Виж <reporting> раздела.',
    );
  });
});
