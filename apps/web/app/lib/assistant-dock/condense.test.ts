import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { CONDENSE_THRESHOLD, condenseForPost, KEEP_RECENT, RECAP_MAX_CHARS } from './condense';
import { selectClientMessages } from '../assistant/chat-input';

function msg(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] } as UIMessage;
}

const reportMessage = (id: string): UIMessage =>
  ({
    id,
    role: 'assistant',
    parts: [
      { type: 'text', text: '| Изпълнител | преамбюл' },
      {
        type: 'tool-emit_report',
        state: 'output-available',
        output: {
          ok: true,
          report: {
            title: 'Топ 5 възложители по разходи (2024)',
            blocks: [
              { type: 'totals', items: [{ label: 'Общо', value: 1200000, format: 'number' }] },
            ],
          },
        },
      },
    ],
  }) as unknown as UIMessage;

describe('condenseForPost', () => {
  it('returns the messages unchanged when at or under the threshold', () => {
    const msgs = Array.from({ length: CONDENSE_THRESHOLD }, (_, i) =>
      msg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`),
    );
    expect(condenseForPost(msgs)).toEqual(msgs);
  });

  it('over the threshold: one recap message followed by the most recent turns, verbatim', () => {
    const msgs = Array.from({ length: 16 }, (_, i) =>
      msg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`),
    );
    const out = condenseForPost(msgs);

    expect(out).toHaveLength(KEEP_RECENT + 1);
    expect(out.slice(1)).toEqual(msgs.slice(-KEEP_RECENT));

    const recap = out[0];
    expect(recap.role).toBe('assistant');
    // Deterministic id derived from the last condensed message, so a retried POST reproduces it.
    expect(recap.id).toBe(`recap-m${16 - KEEP_RECENT - 1}`);
  });

  it('recap text lists the condensed turns chronologically, first line only', () => {
    const msgs = [
      msg('a', 'user', 'Кои са топ 5 възложители?\nвтори ред, който отпада'),
      msg('b', 'assistant', 'Ето топ 5 възложители по разходи.'),
      ...Array.from({ length: 13 }, (_, i) => msg(`m${i}`, 'user', `turn ${i}`)),
    ];
    const out = condenseForPost(msgs);
    const recapText = (out[0].parts[0] as { text: string }).text;

    expect(recapText).toMatch(/^Резюме на по-стария разговор:\n/);
    const bullets = recapText.split('\n').slice(1);
    expect(bullets[0]).toBe('- [потребител] Кои са топ 5 възложители?');
    expect(bullets[1]).toBe('- [асистент] Ето топ 5 възложители по разходи.');
    expect(recapText).not.toContain('втори ред');
  });

  it('assistant turn with a settled report → bullet carries the report title + lead stat, not raw JSON', () => {
    const reportMsg = {
      id: 'r1',
      role: 'assistant',
      parts: [
        { type: 'text', text: '| Изпълнител | преамбюл, който отпада' },
        {
          type: 'tool-emit_report',
          state: 'output-available',
          output: {
            ok: true,
            report: {
              title: 'Топ 5 възложители по разходи (2024)',
              blocks: [
                { type: 'totals', items: [{ label: 'Общо', value: 1200000, format: 'number' }] },
              ],
            },
          },
        },
      ],
    } as unknown as UIMessage;
    const msgs = [
      reportMsg,
      ...Array.from({ length: 14 }, (_, i) => msg(`m${i}`, 'user', `t${i}`)),
    ];

    const recapText = (condenseForPost(msgs)[0].parts[0] as { text: string }).text;
    const bullet = recapText.split('\n')[1];

    expect(bullet).toContain('Топ 5 възложители по разходи (2024)');
    expect(bullet).toContain('Общо');
    expect(bullet).not.toContain('преамбюл');
    expect(bullet).not.toContain('"ok"');
  });

  it('assistant prose after a reportless tool call → pre-tool preamble and <tool_response> echo excluded', () => {
    const proseMsg = {
      id: 'p1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'преамбюл преди инструмента' },
        { type: 'tool-describe_schema', state: 'output-available', output: { tables: [] } },
        { type: 'text', text: '<tool_response>{"raw":1}</tool_response>' },
        { type: 'text', text: 'Схемата съдържа 12 таблици.' },
      ],
    } as unknown as UIMessage;
    const msgs = [proseMsg, ...Array.from({ length: 14 }, (_, i) => msg(`m${i}`, 'user', `t${i}`))];

    const bullet = (condenseForPost(msgs)[0].parts[0] as { text: string }).text.split('\n')[1];
    expect(bullet).toBe('- [асистент] Схемата съдържа 12 таблици.');
  });

  it('caps each bullet gist at 200 characters', () => {
    const long = 'въпрос '.repeat(60); // ~420 chars, single line
    const msgs = [
      msg('a', 'user', long),
      ...Array.from({ length: 14 }, (_, i) => msg(`m${i}`, 'user', `t${i}`)),
    ];

    const bullet = (condenseForPost(msgs)[0].parts[0] as { text: string }).text.split('\n')[1];
    expect(bullet.length).toBeLessThanOrEqual('- [потребител] '.length + 201); // 200 + ellipsis
    expect(bullet.endsWith('…')).toBe(true);
  });

  it('skips malformed and empty turns without throwing', () => {
    const weird = [
      { id: 'w1', role: 'assistant', parts: undefined },
      { id: 'w2', role: 'user', parts: [{ type: 'text' }] },
      { id: 'w3', role: 'user', parts: [{ type: 'text', text: '   ' }] },
    ] as unknown as UIMessage[];
    const msgs = [...weird, ...Array.from({ length: 14 }, (_, i) => msg(`m${i}`, 'user', `t${i}`))];

    const recapText = (condenseForPost(msgs)[0].parts[0] as { text: string }).text;
    const bullets = recapText.split('\n').slice(1);
    // 17 messages → 7 condensed (3 weird + m0..m3); the weird ones are skipped, leaving 4 bullets.
    expect(bullets).toHaveLength(4);
    expect(bullets.every((b) => b.startsWith('- '))).toBe(true);
  });

  it('caps the whole recap, dropping the OLDEST bullets first', () => {
    // 60 condensed turns × ~200-char gists ≫ RECAP_MAX_CHARS — the recap must stay bounded and keep
    // the newest of the condensed turns (the oldest context is the least valuable).
    const older = Array.from({ length: 60 }, (_, i) =>
      msg(`old${i}`, 'user', `въпрос ${i} ${'х'.repeat(190)}`),
    );
    const msgs = [
      ...older,
      ...Array.from({ length: KEEP_RECENT }, (_, i) => msg(`m${i}`, 'user', `t${i}`)),
    ];

    const recapText = (condenseForPost(msgs)[0].parts[0] as { text: string }).text;
    expect(recapText.length).toBeLessThanOrEqual(RECAP_MAX_CHARS);
    expect(recapText).toContain('въпрос 59');
    expect(recapText).not.toContain('въпрос 0 ');
  });

  it('condenses at exactly CONDENSE_THRESHOLD+1 — the first triggering length', () => {
    // At CONDENSE_THRESHOLD (12) the history goes out verbatim (covered above); +1 is the smallest
    // input that condenses. older = the first (13 - KEEP_RECENT) turns, recent = the last KEEP_RECENT.
    const n = CONDENSE_THRESHOLD + 1;
    const msgs = Array.from({ length: n }, (_, i) => msg(`m${i}`, 'user', `turn ${i}`));
    const out = condenseForPost(msgs);

    expect(out).toHaveLength(KEEP_RECENT + 1);
    expect(out[0].id).toBe(`recap-m${n - KEEP_RECENT - 1}`);
    expect(out.slice(1)).toEqual(msgs.slice(-KEEP_RECENT));
    // Exactly (n - KEEP_RECENT) older turns are gisted into bullets — no more, no fewer.
    const bullets = (out[0].parts[0] as { text: string }).text.split('\n').slice(1);
    expect(bullets).toHaveLength(n - KEEP_RECENT);
  });

  it('a report turn inside the recent window is passed through verbatim, not gisted', () => {
    // The last KEEP_RECENT messages are returned by reference (messages.slice(-KEEP_RECENT)). A report
    // there must keep its tool-emit_report part intact — only OLDER reports are reduced to a text gist.
    const report = reportMessage('recent-report');
    const msgs = [
      ...Array.from({ length: 6 }, (_, i) => msg(`old${i}`, 'user', `old ${i}`)),
      ...Array.from({ length: KEEP_RECENT - 1 }, (_, i) => msg(`m${i}`, 'user', `t${i}`)),
      report,
    ];
    const out = condenseForPost(msgs);

    // Same object, untouched — the verbatim path, distinct from the recap path.
    expect(out.at(-1)).toBe(report);
    expect(
      (out.at(-1) as UIMessage).parts.some(
        (p) => (p as { type: string }).type === 'tool-emit_report',
      ),
    ).toBe(true);
  });

  it('the synthetic recap survives the server trust boundary (selectClientMessages)', () => {
    // condenseForPost runs client-side; the server independently re-sanitises via selectClientMessages
    // (drops non-user/assistant roles + non-text parts). The recap is role=assistant with one text part,
    // so it MUST survive — otherwise compression silently no-ops and the model loses all older context.
    const msgs = Array.from({ length: 16 }, (_, i) =>
      msg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`),
    );
    const server = selectClientMessages(condenseForPost(msgs), 24);

    expect(server[0].id).toMatch(/^recap-/);
    expect(server[0].role).toBe('assistant');
    expect((server[0].parts[0] as { text: string }).text).toContain(
      'Резюме на по-стария разговор:',
    );
    // The whole condensed thread survives (1 recap + KEEP_RECENT), none evicted by the server boundary.
    expect(server).toHaveLength(KEEP_RECENT + 1);
  });
});
