import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { createPhaseFilter } from './stream-phase';
import { GATEWAY_OVERLOADED_MESSAGE } from './stream-errors';

// Cast a hand-built RAW UIMessageChunk (the wire shape the filter consumes) — NOT the persisted
// `tool-<name>` part shape; those are different layers. The cast crosses that boundary once here.
const asChunk = (raw: unknown): UIMessageChunk => raw as UIMessageChunk;

const start = () => asChunk({ type: 'start' });
const finish = () => asChunk({ type: 'finish' });
const text = (id: string, delta: string) => asChunk({ type: 'text-delta', id, delta });
const toolInputStart = (toolCallId: string, toolName: string) =>
  asChunk({ type: 'tool-input-start', toolCallId, toolName });
const toolInputDelta = (toolCallId: string, inputTextDelta: string) =>
  asChunk({ type: 'tool-input-delta', toolCallId, inputTextDelta });
const toolInputAvailable = (toolCallId: string, toolName: string, input: unknown) =>
  asChunk({ type: 'tool-input-available', toolCallId, toolName, input });
const toolOutput = (toolCallId: string, output: unknown) =>
  asChunk({ type: 'tool-output-available', toolCallId, output });
const toolOutputError = (toolCallId: string, errorText: string) =>
  asChunk({ type: 'tool-output-error', toolCallId, errorText });
const toolInputError = (toolCallId: string, toolName: string, errorText: string) =>
  asChunk({ type: 'tool-input-error', toolCallId, toolName, errorText });
const phase = (p: 'thinking' | 'querying' | 'composing') =>
  asChunk({ type: 'data-phase', data: { phase: p }, transient: true });

// Drive a scripted chunk sequence through the transform and collect the exact output.
async function runFilter(chunks: UIMessageChunk[]): Promise<UIMessageChunk[]> {
  const filter = createPhaseFilter();
  const writer = filter.writable.getWriter();
  const reader = filter.readable.getReader();
  const out: UIMessageChunk[] = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      out.push(value);
    }
  })();
  for (const chunk of chunks) await writer.write(chunk);
  await writer.close();
  await pump;
  return out;
}

describe('createPhaseFilter', () => {
  it('emits the thinking phase right after the start chunk', async () => {
    expect(await runFilter([start()])).toEqual([start(), phase('thinking')]);
  });

  it('drops the whole run_sql cycle (SQL input + raw rows) and collapses it to one querying phase', async () => {
    const out = await runFilter([
      toolInputStart('c1', 'run_sql'),
      toolInputDelta('c1', '{"sql":"SELECT amount_eur'),
      toolInputAvailable('c1', 'run_sql', { sql: 'SELECT amount_eur FROM contracts' }),
      toolOutput('c1', 'R1 (5 rows): МЗ|123456789'),
    ]);
    expect(out).toEqual([phase('querying')]);
  });

  it('emits querying once for consecutive internal tool chunks (dedup)', async () => {
    const out = await runFilter([
      toolInputStart('c1', 'run_sql'),
      toolInputStart('c2', 'describe_schema'),
    ]);
    expect(out).toEqual([phase('querying')]);
  });

  it('passes emit_report chunks through intact and emits the composing phase', async () => {
    const output = { ok: true, report: { title: 'Топ 5', question: 'q', blocks: [] } };
    const out = await runFilter([
      toolInputStart('c3', 'emit_report'),
      toolInputAvailable('c3', 'emit_report', { title: 'Топ 5', blocks: [] }),
      toolOutput('c3', output),
    ]);
    expect(out).toEqual([
      phase('composing'),
      toolInputStart('c3', 'emit_report'),
      toolInputAvailable('c3', 'emit_report', { title: 'Топ 5', blocks: [] }),
      toolOutput('c3', output),
    ]);
  });

  it('redacts the schema-echoing errors from a failed emit_report output', async () => {
    const out = await runFilter([
      toolInputStart('c3', 'emit_report'),
      toolOutput('c3', { ok: false, errors: ['result "R1" has no column "amount_eur"', 'row 5'] }),
    ]);
    expect(out).toEqual([
      phase('composing'),
      toolInputStart('c3', 'emit_report'),
      toolOutput('c3', { ok: false, errors: [] }),
    ]);
  });

  it('masks the raw errorText of a thrown emit_report (tool-output-error)', async () => {
    const out = await runFilter([
      toolInputStart('c3', 'emit_report'),
      toolOutputError('c3', 'TypeError: no such column contracts.foo'),
    ]);
    expect(out).toEqual([
      phase('composing'),
      toolInputStart('c3', 'emit_report'),
      toolOutputError('c3', 'Справката не можа да бъде съставена.'),
    ]);
  });

  it('masks the raw errorText of an emit_report input-schema error (tool-input-error)', async () => {
    const out = await runFilter([
      toolInputStart('c3', 'emit_report'),
      toolInputError('c3', 'emit_report', 'SCHEMAECHO_amount_eur_malformed'),
    ]);
    expect(out).toEqual([
      phase('composing'),
      toolInputStart('c3', 'emit_report'),
      toolInputError('c3', 'emit_report', 'Справката не можа да бъде съставена.'),
    ]);
  });

  it('drops an unattributed tool output (unknown toolCallId) — fail closed', async () => {
    const out = await runFilter([toolOutput('ghost', 'SELECT leaked FROM secrets')]);
    expect(out).toEqual([phase('querying')]);
  });

  it('drops reasoning chunks', async () => {
    expect(
      await runFilter([asChunk({ type: 'reasoning-delta', id: 'r1', delta: 'plan the SQL' })]),
    ).toEqual([]);
  });

  it('drops source, file, and message-metadata chunks (strict allowlist)', async () => {
    const out = await runFilter([
      asChunk({ type: 'source-url', sourceId: 's1', url: 'https://x' }),
      asChunk({ type: 'file', url: 'https://f', mediaType: 'text/csv' }),
      asChunk({ type: 'message-metadata', messageMetadata: { usage: 42 } }),
    ]);
    expect(out).toEqual([]);
  });

  it('passes the data-report-ready part through unchanged', async () => {
    const ready = asChunk({
      type: 'data-report-ready',
      data: { reportId: 'abc', title: 'Справка' },
    });
    expect(await runFilter([ready])).toEqual([ready]);
  });

  it('passes the masked error chunk through verbatim — the gateway-429 shed message reaches the wire', async () => {
    const shed = asChunk({ type: 'error', errorText: GATEWAY_OVERLOADED_MESSAGE });
    expect(await runFilter([shed])).toEqual([shed]);
  });

  it('passes text and structural markers through unchanged', async () => {
    const out = await runFilter([
      asChunk({ type: 'start-step' }),
      text('t1', 'здравей'),
      asChunk({ type: 'finish-step' }),
      finish(),
    ]);
    expect(out).toEqual([
      asChunk({ type: 'start-step' }),
      text('t1', 'здравей'),
      asChunk({ type: 'finish-step' }),
      finish(),
    ]);
  });

  it('re-emits querying after composing when a new tool cycle starts', async () => {
    const out = await runFilter([
      toolInputStart('c3', 'emit_report'),
      toolInputStart('c1', 'run_sql'),
    ]);
    expect(out).toEqual([
      phase('composing'),
      toolInputStart('c3', 'emit_report'),
      phase('querying'),
    ]);
  });

  it('drops malformed chunks without throwing', async () => {
    const out = await runFilter([
      asChunk(null),
      asChunk({}),
      asChunk({ type: 123 }),
      text('t1', 'оцелях'),
    ]);
    expect(out).toEqual([text('t1', 'оцелях')]);
  });

  it('produces the exact wire for a full realistic turn', async () => {
    const report = { ok: true, report: { title: 'Топ 5 възложители', question: 'q', blocks: [] } };
    const out = await runFilter([
      start(),
      text('t1', 'Проверявам данните.'),
      toolInputStart('c1', 'run_sql'),
      toolInputDelta('c1', '{"sql":"SELECT ...'),
      toolOutput('c1', 'R1 (5 rows)'),
      toolInputStart('c2', 'emit_report'),
      toolOutput('c2', report),
      text('t2', 'Ето топ 5 възложители.'),
      finish(),
    ]);
    expect(out).toEqual([
      start(),
      phase('thinking'),
      text('t1', 'Проверявам данните.'),
      phase('querying'),
      phase('composing'),
      toolInputStart('c2', 'emit_report'),
      toolOutput('c2', report),
      text('t2', 'Ето топ 5 възложители.'),
      finish(),
    ]);
  });
});
