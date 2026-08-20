import { describe, expect, it } from 'vitest';
import {
  buildFallbackReport,
  FALLBACK_TITLE,
  guessFormat,
  humanizeColumn,
} from './report-fallback';
import type { QueryResult } from './report-schema';

describe('buildFallbackReport — server-side last-resort finalizer', () => {
  it('renders a single-row numeric result as a totals block with server-bound values', () => {
    const results: QueryResult[] = [
      { handle: 'R1', columns: ['total_spent_eur', 'contract_count'], rows: [[250264972.88, 293]] },
    ];
    const out = buildFallbackReport(results, 'Колко похарчи Столична община през 2023 г.?');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.report.title).toBe(FALLBACK_TITLE);
      expect(out.report.question).toBe('Колко похарчи Столична община през 2023 г.?');
      expect(out.report.watermark).toBe('ai-generated');
      const block = out.report.blocks[0]!;
      expect(block.type).toBe('totals');
      if (block.type === 'totals') {
        // labels are humanized Bulgarian, not the raw SQL column names
        expect(block.items).toEqual([
          { label: 'Общо похарчено (€)', value: 250264972.88, format: 'money' },
          { label: 'Брой договори', value: 293, format: 'number' },
        ]);
      }
    }
  });

  it('renders a multi-row result as a table taken wholesale from the result', () => {
    const results: QueryResult[] = [
      {
        handle: 'R1',
        columns: ['name', 'spent_eur'],
        rows: [
          ['СОФЕКОСТРОЙ ЕАД', 91800000],
          ['СОФИНВЕСТ ЕАД', 73600000],
        ],
      },
    ];
    const out = buildFallbackReport(results, 'топ изпълнители');
    expect(out.ok).toBe(true);
    if (out.ok) {
      const block = out.report.blocks[0]!;
      expect(block.type).toBe('table');
      if (block.type === 'table') {
        expect(block.columns.map((c) => c.key)).toEqual(['name', 'spent_eur']);
        expect(block.rows).toHaveLength(2);
        expect(block.rows[0]!.cells).toEqual(['СОФЕКОСТРОЙ ЕАД', 91800000]);
      }
    }
  });

  it('refuses a single text-only row — no measure, nothing quantitative to report', () => {
    // A lone label row (a bare entity name with no figure) carries nothing to summarise. Before the quality
    // bar this published as a 1-cell table; now the turn shows the rephrase affordance instead of a hollow
    // „Справка". Structurally identical to the „division: 45" probe defect below.
    const results: QueryResult[] = [
      { handle: 'R1', columns: ['name'], rows: [['СТОЛИЧНА ОБЩИНА']] },
    ];
    expect(buildFallbackReport(results, 'q').ok).toBe(false);
  });

  it('refuses a single-row dimensional probe (the „Division / 45" meaningless-report defect)', () => {
    // Regression: on a greeting the weak model ran a stray `SELECT division …` returning one CPV code.
    // results.length > 0, so the finalizer used to publish it as an authoritative 1-cell „Справка". A lone
    // dimension code answers nothing → refuse; agent.ts then writes the rephrase affordance.
    const results: QueryResult[] = [{ handle: 'R1', columns: ['division'], rows: [['45']] }];
    expect(buildFallbackReport(results, 'Здравей').ok).toBe(false);
  });

  it('still renders a MULTI-row text-only result as a table (a list is substantive, not over-rejected)', () => {
    // The measure bar is single-row-only: a genuine list of entities (even without figures) is a real answer.
    const results: QueryResult[] = [
      { handle: 'R1', columns: ['authority'], rows: [['СТОЛИЧНА ОБЩИНА'], ['ОБЩИНА ПЛОВДИВ']] },
    ];
    const out = buildFallbackReport(results, 'изброй възложителите');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.report.blocks[0]!.type).toBe('table');
  });

  it('renders a single row with a text label + number as a table (keeps the entity name)', () => {
    // A single-row „who spent the most" answer must NOT collapse into a totals block — that would show
    // „91,8 млн. €" and silently drop „СОФЕКОСТРОЙ ЕАД". A 1-row table preserves the label column.
    const results: QueryResult[] = [
      { handle: 'R1', columns: ['name', 'spent_eur'], rows: [['СОФЕКОСТРОЙ ЕАД', 91800000]] },
    ];
    const out = buildFallbackReport(results, 'кой похарчи най-много');
    expect(out.ok).toBe(true);
    if (out.ok) {
      const block = out.report.blocks[0]!;
      expect(block.type).toBe('table');
      if (block.type === 'table') {
        expect(block.columns.map((c) => c.key)).toEqual(['name', 'spent_eur']);
        expect(block.rows).toHaveLength(1);
        expect(block.rows[0]!.cells).toEqual(['СОФЕКОСТРОЙ ЕАД', 91800000]);
      }
    }
  });

  it('picks the LAST non-empty result (the model’s final answer query)', () => {
    const results: QueryResult[] = [
      { handle: 'R1', columns: ['x'], rows: [[1]] },
      { handle: 'R2', columns: ['final_eur'], rows: [[999]] },
    ];
    const out = buildFallbackReport(results, 'q');
    expect(out.ok).toBe(true);
    if (out.ok && out.report.blocks[0]!.type === 'totals') {
      expect(out.report.blocks[0].items[0]!.value).toBe(999);
    }
  });

  it('skips a trailing EMPTY result and falls back to the last one that has rows', () => {
    const results: QueryResult[] = [
      { handle: 'R1', columns: ['spent_eur'], rows: [[500]] },
      { handle: 'R2', columns: ['x'], rows: [] }, // a refinement that returned nothing
    ];
    const out = buildFallbackReport(results, 'q');
    expect(out.ok).toBe(true);
    if (out.ok && out.report.blocks[0]!.type === 'totals') {
      expect(out.report.blocks[0].items[0]!.value).toBe(500);
    }
  });

  it('downgrades a share-named column to a number when its value is not a 0..1 ratio', () => {
    // guessFormat picks 'percent' from a „share/дял" column name; if the single-row value is actually a
    // raw sum (not a 0..1 ratio) it must not render as an absurd „…%".
    const results: QueryResult[] = [
      { handle: 'R1', columns: ['share'], rows: [[1342360573264.6]] },
    ];
    const out = buildFallbackReport(results, 'дял с една оферта');
    expect(out.ok).toBe(true);
    if (out.ok && out.report.blocks[0]!.type === 'totals') {
      expect(out.report.blocks[0].items[0]!.format).toBe('number');
      expect(out.report.blocks[0].items[0]!.value).toBe(1342360573264.6);
    }
  });

  it('keeps percent format for a genuine 0..1 share value', () => {
    const results: QueryResult[] = [
      { handle: 'R1', columns: ['single_offer_share'], rows: [[0.318]] },
    ];
    const out = buildFallbackReport(results, 'дял с една оферта');
    expect(out.ok).toBe(true);
    if (out.ok && out.report.blocks[0]!.type === 'totals') {
      expect(out.report.blocks[0].items[0]!.format).toBe('percent');
    }
  });

  it('returns ok:false when there is nothing to summarise (no rows anywhere)', () => {
    expect(buildFallbackReport([], 'q').ok).toBe(false);
    expect(buildFallbackReport([{ handle: 'R1', columns: ['a'], rows: [] }], 'q').ok).toBe(false);
  });

  it('the fixed title carries no material number, so it can never trip the E2 gate', () => {
    // A single row whose SQL total is huge must still bind — the title is a constant, never the number.
    const results: QueryResult[] = [{ handle: 'R1', columns: ['sum_eur'], rows: [[12000000000]] }];
    const out = buildFallbackReport(results, 'общо усвоени');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.report.title).toBe(FALLBACK_TITLE);
  });

  it('renders a bid/offer COUNT as a plain number, never as euros (value-basis defect)', () => {
    // A bid/offer tally aliased total_bids/sum_offers has no currency token — the bare „total"/„sum" must
    // not steal it into money. 5 bids must read as „5" under a count label, not „5,00 €".
    const results: QueryResult[] = [{ handle: 'R1', columns: ['total_bids'], rows: [[5]] }];
    const out = buildFallbackReport(results, 'общо оферти');
    expect(out.ok).toBe(true);
    if (out.ok && out.report.blocks[0]!.type === 'totals') {
      expect(out.report.blocks[0].items[0]).toEqual({
        label: 'Брой оферти',
        value: 5,
        format: 'number',
      });
    }
  });
});

describe('guessFormat', () => {
  it('maps common column names to display formats', () => {
    expect(guessFormat('total_spent_eur')).toBe('money');
    expect(guessFormat('amount_eur')).toBe('money');
    expect(guessFormat('contract_count')).toBe('number');
    expect(guessFormat('single_offer_share')).toBe('percent');
    expect(guessFormat('signed_at')).toBe('date');
    expect(guessFormat('authority_name')).toBe('text');
  });

  it('reads a count as a number even when its name carries a generic „total" aggregate', () => {
    // total_count / total_contracts are TALLIES, not euro sums — the generic „total" must not steal them
    // into the money format ahead of the count shape. A hard currency token still wins (total_spent_eur).
    expect(guessFormat('total_count')).toBe('number');
    expect(guessFormat('total_contracts')).toBe('number');
    expect(guessFormat('total_spent_eur')).toBe('money');
    expect(guessFormat('won_eur')).toBe('money');
  });

  it('reads a bid/offer count as a number even under a generic „total"/„sum" aggregate', () => {
    // total_bids / sum_offers are TALLIES with no currency token — they must not fall through to money.
    expect(guessFormat('total_bids')).toBe('number');
    expect(guessFormat('sum_offers')).toBe('number');
    expect(guessFormat('оферти')).toBe('number');
    // a real sum/total with a currency token still wins as money
    expect(guessFormat('total_amount_eur')).toBe('money');
    expect(guessFormat('sum_value_eur')).toBe('money');
  });
});

describe('humanizeColumn', () => {
  it('maps the columns the model produces to Bulgarian labels (no raw identifiers)', () => {
    expect(humanizeColumn('total_spent_eur')).toBe('Общо похарчено (€)');
    expect(humanizeColumn('contracts_count')).toBe('Брой договори');
    expect(humanizeColumn('contract_count')).toBe('Брой договори');
    expect(humanizeColumn('won_eur')).toBe('Спечелено (€)');
    expect(humanizeColumn('total_eur')).toBe('Обща стойност (€)');
    expect(humanizeColumn('authority_name')).toBe('Възложител');
    expect(humanizeColumn('bidder_name')).toBe('Изпълнител');
    expect(humanizeColumn('single_offer_share')).toBe('Дял с една оферта');
    expect(humanizeColumn('period')).toBe('Период');
    expect(humanizeColumn('year')).toBe('Година');
  });

  it('labels a bid/offer count as a count, not „Обща стойност (€)"', () => {
    // The over-broad „total"/„sum" must not put a tally under a euro label.
    expect(humanizeColumn('total_bids')).toBe('Брой оферти');
    expect(humanizeColumn('sum_offers')).toBe('Брой оферти');
    expect(humanizeColumn('total_count')).toBe('Брой');
    // genuine value columns keep the euro label
    expect(humanizeColumn('total_value_eur')).toBe('Обща стойност (€)');
    expect(humanizeColumn('sum_amount')).toBe('Обща стойност (€)');
  });

  it('degrades an unmapped column to a de-snaked, capitalised label — never the raw identifier', () => {
    expect(humanizeColumn('some_custom_field')).toBe('Some custom field');
    expect(humanizeColumn('widget_id')).toBe('Widget');
  });
});
