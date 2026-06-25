import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
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
      input: {
        title: 'Заглавие на справка',
        blocks: [{ type: 'totals', items: [{ label: 'Сума', value: 100, format: 'money' }] }],
      },
      output: { id: 'r_1', title: 'Заглавие на справка', url: '/reports/r_1' },
    },
  ]);

const pendingMessage = (id: string) =>
  message(id, 'assistant', [{ type: 'tool-run_sql', state: 'input-available' }]);

const failedReportMessage = (id: string) =>
  message(id, 'assistant', [
    {
      type: 'tool-emit_report',
      state: 'output-available',
      output: { error: 'Справката е твърде голяма.' },
    },
  ]);

// The report chip renders a router <Link>, so a router context is required.
const renderTranscript = (messages: UIMessage[]) => {
  const Stub = createRoutesStub([
    { path: '/', Component: () => <AssistantTranscript messages={messages} /> },
  ]);
  render(<Stub />);
};

describe('AssistantTranscript', () => {
  it('renders message prose', () => {
    renderTranscript([userMessage('1', 'Здравейте')]);

    expect(screen.getByText('Здравейте')).toBeInTheDocument();
  });

  it('renders a report chip for a finished report', () => {
    renderTranscript([reportMessage('2')]);

    expect(screen.getByText('Заглавие на справка')).toBeInTheDocument();
  });

  it('links the chip to the report URL', () => {
    renderTranscript([reportMessage('2')]);

    expect(screen.getByRole('link', { name: 'Отвори' })).toHaveAttribute('href', '/reports/r_1');
  });

  it('does not render a chip for a prose-only message', () => {
    renderTranscript([userMessage('3', 'само текст')]);

    expect(screen.queryByText('Заглавие на справка')).not.toBeInTheDocument();
  });

  it('shows a per-tool progress line while a tool runs', () => {
    renderTranscript([pendingMessage('4')]);

    expect(screen.getByText('Изпълнява заявка…')).toBeInTheDocument();
  });

  it('shows the server error when a report could not be stored', () => {
    renderTranscript([failedReportMessage('5')]);

    expect(screen.getByText('Справката е твърде голяма.')).toBeInTheDocument();
  });
});
