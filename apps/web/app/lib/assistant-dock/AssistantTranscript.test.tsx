import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { AssistantTranscript } from './AssistantTranscript';

afterEach(() => {
  cleanup();
});

// Minimal hand-built messages — the SDK's UIMessage part union is stricter than these fixtures need,
// so the cast crosses that boundary in one place.
const message = (id: string, role: 'user' | 'assistant', parts: unknown[]): UIMessage =>
  ({ id, role, parts }) as unknown as UIMessage;

const userMessage = (id: string, text: string) => message(id, 'user', [{ type: 'text', text }]);

const reportMessage = (id: string) =>
  message(id, 'assistant', [
    { type: 'text', text: 'Ето справката:' },
    {
      type: 'tool-emit_report',
      state: 'output-available',
      output: {
        ok: true,
        report: {
          title: 'Заглавие на справка',
          question: 'q',
          watermark: 'ai-generated',
          blocks: [{ type: 'totals', items: [{ label: 'Сума', value: 100, format: 'money' }] }],
        },
      },
    },
  ]);

const pendingMessage = (id: string) =>
  message(id, 'assistant', [{ type: 'tool-emit_report', state: 'input-available' }]);

const failedReportMessage = (id: string) =>
  message(id, 'assistant', [
    { type: 'tool-emit_report', state: 'output-available', output: { ok: false, errors: ['x'] } },
  ]);

describe('AssistantTranscript', () => {
  it('renders message prose', () => {
    render(<AssistantTranscript messages={[userMessage('1', 'Здравейте')]} />);

    expect(screen.getByText('Здравейте')).toBeInTheDocument();
  });

  it('renders a report chip for a finished report', () => {
    render(<AssistantTranscript messages={[reportMessage('2')]} />);

    expect(screen.getByText('Заглавие на справка')).toBeInTheDocument();
  });

  it('does not render a chip for a prose-only message', () => {
    render(<AssistantTranscript messages={[userMessage('3', 'само текст')]} />);

    expect(screen.queryByText('Заглавие на справка')).not.toBeInTheDocument();
  });

  it('shows a preparing indicator while a report is being composed', () => {
    render(<AssistantTranscript messages={[pendingMessage('4')]} />);

    expect(screen.getByText('Подготвям справка…')).toBeInTheDocument();
  });

  it('shows a failure line when the report could not be composed', () => {
    render(<AssistantTranscript messages={[failedReportMessage('5')]} />);

    expect(screen.getByText('Справката не можа да бъде съставена.')).toBeInTheDocument();
  });
});
