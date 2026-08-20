import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';
import type { UIMessage } from 'ai';
import { AssistantTranscript } from './AssistantTranscript';
import { addToReportIndex } from './storage';
import { DEDUP_PART } from '../../../workers/assistant/dedup-stream';

afterEach(() => {
  cleanup();
});

// A cache-hit turn: the route streams a single `data-dedup` part (no emit_report tool ran).
const dedupMessage = (id: string, reportId = 'r_abc') =>
  message(id, 'assistant', [
    {
      type: DEDUP_PART,
      data: {
        reportId,
        createdAt: '2026-07-06T00:00:00Z',
        layer: 'L1',
        label: 'Преизползване на съществуващ отчет',
      },
    },
  ]);

// The reuse chip renders a react-router <Link>, so these render inside a router.
const renderInRouter = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

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

const failedReportMessage = (id: string) =>
  message(id, 'assistant', [
    { type: 'tool-emit_report', state: 'output-available', output: { ok: false, errors: ['x'] } },
  ]);

// A turn that ran tool calls (run_sql) but never emitted a report — the "out of steps" case.
const toolOnlyMessage = (id: string) =>
  message(id, 'assistant', [
    { type: 'tool-run_sql', state: 'output-available', output: 'R1 (колони: …) — 100 ред(а)' },
  ]);

const NO_ANSWER =
  /Не разполагам с достатъчно информация, за да отговоря прецизно на този въпрос\. Опитайте по-конкретно/;

describe('AssistantTranscript', () => {
  it('renders message prose', () => {
    render(
      <AssistantTranscript
        messages={[userMessage('1', 'Здравейте')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(screen.getByText('Здравейте')).toBeInTheDocument();
  });

  it('renders a report chip for a finished report', () => {
    render(
      <AssistantTranscript
        messages={[reportMessage('2')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(screen.getByText('Заглавие на справка')).toBeInTheDocument();
  });

  it('does not render a chip for a prose-only message', () => {
    render(
      <AssistantTranscript
        messages={[userMessage('3', 'само текст')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(screen.queryByText('Заглавие на справка')).not.toBeInTheDocument();
  });

  it('shows a failure line when the report could not be composed', () => {
    render(
      <AssistantTranscript
        messages={[failedReportMessage('5')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(
      screen.getByText('Справката не можа да бъде съставена. Опитайте отново.'),
    ).toBeInTheDocument();
  });

  it('renders the phase line inside the aria-live log region', () => {
    render(
      <AssistantTranscript
        messages={[userMessage('6', 'въпрос')]}
        phase="querying"
        busy={false}
        aborted={false}
      />,
    );

    expect(within(screen.getByRole('log')).getByText('Търся в данните…')).toBeInTheDocument();
  });

  it('renders no phase line when idle', () => {
    render(
      <AssistantTranscript
        messages={[userMessage('7', 'въпрос')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(screen.queryByText('Търся в данните…')).not.toBeInTheDocument();
  });

  it('withholds a failed report result on the streaming message while busy', () => {
    render(
      <AssistantTranscript
        messages={[failedReportMessage('9')]}
        phase="composing"
        busy={true}
        aborted={false}
      />,
    );

    expect(screen.getByText('Съставям справка…')).toBeInTheDocument();
    expect(
      screen.queryByText('Справката не можа да бъде съставена. Опитайте отново.'),
    ).not.toBeInTheDocument();
  });

  // #31 fallback: the model's original emit_report is orphaned at input-available; the settled turn
  // still renders the chip from the output-available part, and #24's filter tags it via the phase line.
  it('renders the chip for a fallback report with an orphaned emit_report part', () => {
    const stuck = message('4c', 'assistant', [
      { type: 'tool-emit_report', state: 'input-available' },
      {
        type: 'tool-emit_report',
        state: 'output-available',
        output: {
          ok: true,
          report: {
            title: 'Справка по наличните данни',
            question: 'q',
            watermark: 'ai-generated',
            blocks: [{ type: 'totals', items: [{ label: 'Сума', value: 100, format: 'money' }] }],
          },
        },
      },
    ]);
    render(<AssistantTranscript messages={[stuck]} phase={null} busy={false} aborted={false} />);

    expect(screen.getByText('Справка по наличните данни')).toBeInTheDocument();
  });

  it('shows the failed report result once the turn settles', () => {
    render(
      <AssistantTranscript
        messages={[failedReportMessage('10')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(
      screen.getByText('Справката не можа да бъде съставена. Опитайте отново.'),
    ).toBeInTheDocument();
  });

  it('does NOT flash the failure line for an ok:false on the last turn while still busy (retry pending)', () => {
    // A first emit returns ok:false and the loop retries; the failure line must not flash before the
    // successful retry lands. While busy the phase line carries the state instead.
    render(
      <AssistantTranscript
        messages={[failedReportMessage('5b')]}
        phase="composing"
        busy={true}
        aborted={false}
      />,
    );

    expect(
      screen.queryByText('Справката не можа да бъде съставена. Опитайте отново.'),
    ).not.toBeInTheDocument();
  });

  it('still shows the failure line for an earlier settled turn while a new turn streams', () => {
    // An earlier turn that genuinely ended ok:false keeps its failure line even though a later turn is busy.
    render(
      <AssistantTranscript
        messages={[failedReportMessage('5c'), userMessage('5d', 'нов въпрос')]}
        phase="thinking"
        busy={true}
        aborted={false}
      />,
    );

    expect(
      screen.getByText('Справката не можа да бъде съставена. Опитайте отново.'),
    ).toBeInTheDocument();
  });

  it('shows the no-answer fallback when a settled turn made tool calls but no report', () => {
    render(
      <AssistantTranscript
        messages={[toolOnlyMessage('11')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(screen.getByText(NO_ANSWER)).toBeInTheDocument();
  });

  it('does NOT show the fallback while the turn is still streaming', () => {
    render(
      <AssistantTranscript
        messages={[toolOnlyMessage('12')]}
        phase={null}
        busy={true}
        aborted={false}
      />,
    );

    expect(screen.queryByText(NO_ANSWER)).not.toBeInTheDocument();
  });

  it('does NOT show the fallback for a completed report turn', () => {
    render(
      <AssistantTranscript
        messages={[reportMessage('13')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(screen.queryByText(NO_ANSWER)).not.toBeInTheDocument();
  });
});

// WCAG 4.1.3: the polite log announces settled content; the in-flight message is silenced (its text
// mutates on every token batch) and turn completion is announced once via a separate status region.
describe('AssistantTranscript — live region for streamed tokens', () => {
  const proseAssistant = (id: string, text: string) =>
    message(id, 'assistant', [{ type: 'text', text }]);

  it('keeps the log region attributes (role, polite, label)', () => {
    render(
      <AssistantTranscript
        messages={[userMessage('l1', 'въпрос')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveAttribute('aria-label', 'Разговор с асистента');
  });

  it('silences only the streaming (last) turn with aria-live="off"', () => {
    const { container } = render(
      <AssistantTranscript
        messages={[
          proseAssistant('s1', 'стар отговор'),
          userMessage('s2', 'въпрос'),
          proseAssistant('s3', 'частичен отго'),
        ]}
        phase="composing"
        busy={true}
        aborted={false}
      />,
    );

    const turns = container.querySelectorAll('.assistant-turn');
    expect(turns[turns.length - 1].getAttribute('aria-live')).toBe('off');
    expect(turns[0].getAttribute('aria-live')).toBeNull();
    expect(turns[1].getAttribute('aria-live')).toBeNull();
  });

  it('does not silence any turn when idle', () => {
    const { container } = render(
      <AssistantTranscript
        messages={[proseAssistant('i1', 'отговор')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(container.querySelector('.assistant-turn[aria-live="off"]')).toBeNull();
  });

  it('announces a settled prose turn once busy flips false', () => {
    const { rerender } = render(
      <AssistantTranscript
        messages={[proseAssistant('p1', 'частичен')]}
        phase="composing"
        busy={true}
        aborted={false}
      />,
    );
    rerender(
      <AssistantTranscript
        messages={[proseAssistant('p1', 'пълен отговор')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain('Отговорът е готов');
  });

  it('announces a settled report turn with its title', () => {
    const { rerender } = render(
      <AssistantTranscript
        messages={[reportMessage('r1')]}
        phase="composing"
        busy={true}
        aborted={false}
      />,
    );
    rerender(
      <AssistantTranscript
        messages={[reportMessage('r1')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain(
      'Готова е справка: Заглавие на справка',
    );
  });

  it('does not announce on initial mount with settled messages', () => {
    render(
      <AssistantTranscript
        messages={[reportMessage('m1')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('announces „Отговорът е прекъснат" when the turn was stopped by the user', () => {
    // Stop aborts the stream but the SDK settles to status:ready exactly like a natural finish —
    // announcing „готов" would tell an SR user their cancelled answer completed (PR #48 blocker).
    const { rerender } = render(
      <AssistantTranscript
        messages={[proseAssistant('ab1', 'частичен отго')]}
        phase="composing"
        busy={true}
        aborted={false}
      />,
    );
    rerender(
      <AssistantTranscript
        messages={[proseAssistant('ab1', 'частичен отго')]}
        phase={null}
        busy={false}
        aborted={true}
      />,
    );

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Отговорът е прекъснат');
    expect(status.textContent).not.toContain('Отговорът е готов');
  });

  it('announces an interrupted report turn as „прекъснат", not as a finished report', () => {
    const { rerender } = render(
      <AssistantTranscript
        messages={[reportMessage('ab2')]}
        phase="composing"
        busy={true}
        aborted={false}
      />,
    );
    rerender(
      <AssistantTranscript
        messages={[reportMessage('ab2')]}
        phase={null}
        busy={false}
        aborted={true}
      />,
    );

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Отговорът е прекъснат');
    expect(status.textContent).not.toContain('Готова е справка');
  });

  it('stays silent for a failed report turn (the in-log failure line announces instead)', () => {
    const { rerender } = render(
      <AssistantTranscript
        messages={[failedReportMessage('f1')]}
        phase="composing"
        busy={true}
        aborted={false}
      />,
    );
    rerender(
      <AssistantTranscript
        messages={[failedReportMessage('f1')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe('');
  });
});

// A cache hit runs no emit_report tool — the route streams a single data-dedup part — so the transcript
// renders a "reuse existing report" chip from it, linking to the immutable report at /reports/:id (§3c).
// Without this the hit turn rendered blank ("dedup does nothing"), even though the backend deduped fine.
describe('AssistantTranscript — dedup cache hit (reuse affordance)', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('renders a reuse chip linking to the report, labelled from the part when not locally indexed', () => {
    renderInRouter(
      <AssistantTranscript
        messages={[dedupMessage('d1')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(screen.getByText('Преизползване на съществуващ отчет')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Отвори' })).toHaveAttribute('href', '/reports/r_abc');
  });

  it('enriches the chip with the real title + lead stat when the report is in the local index', () => {
    addToReportIndex({
      id: 'r_abc',
      title: 'Месечен разход за 2024 г.',
      question: 'q',
      createdAt: '2026-07-06T00:00:00Z',
      leadStat: 'Общ разход: 9,65 млрд. €',
    });

    renderInRouter(
      <AssistantTranscript
        messages={[dedupMessage('d2')]}
        phase={null}
        busy={false}
        aborted={false}
      />,
    );

    expect(screen.getByText('Месечен разход за 2024 г.')).toBeInTheDocument();
    expect(screen.getByText('Общ разход: 9,65 млрд. €')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Отвори' })).toHaveAttribute('href', '/reports/r_abc');
  });

  it('withholds the reuse chip while the hit turn is still streaming', () => {
    renderInRouter(
      <AssistantTranscript
        messages={[dedupMessage('d3')]}
        phase="thinking"
        busy={true}
        aborted={false}
      />,
    );

    expect(screen.queryByRole('link', { name: 'Отвори' })).not.toBeInTheDocument();
  });

  it('announces the reused report once the turn settles', () => {
    const { rerender } = render(
      <MemoryRouter>
        <AssistantTranscript
          messages={[dedupMessage('d4')]}
          phase="thinking"
          busy={true}
          aborted={false}
        />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter>
        <AssistantTranscript
          messages={[dedupMessage('d4')]}
          phase={null}
          busy={false}
          aborted={false}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('status').textContent).toContain(
      'Готова е справка: Преизползване на съществуващ отчет',
    );
  });
});
