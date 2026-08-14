// #305 — the value-double-count text heuristic, tested against REAL основание text pulled from the live
// corpus (contracts 145652, 189325, 84818, 108677, 79382, 113291, 103903). The hazard is false positives,
// so the controls (genuine increment, uncorrectable, normal increase) matter as much as the hits.
import { describe, expect, it } from 'vitest';
import {
  classifyAmendmentValue,
  restatedValueAfter,
  isGenuineIncrement,
  type AmendmentValueInput,
} from './amendment-total';

const mk = (
  valueBefore: number,
  valueAfter: number,
  valueDelta: number,
  currency: string,
  ...texts: string[]
): AmendmentValueInput => ({ valueBefore, valueAfter, valueDelta, currency, texts });

describe('#305 amendment value double-count heuristic', () => {
  it('restates a total announced as "…на <delta>" (145652)', () => {
    const t = classifyAmendmentValue(
      mk(
        442000,
        981240,
        539240,
        'BGN',
        'относно актуализиране стойността на договора … общата стойност на договора ще възлезе на 539 240.00 лв. без ДДС',
      ),
    );
    expect(t).toEqual({ kind: 'total_restated', correctedAfter: 539240 });
  });

  it('restates a total announced as "…от X на <delta>" (79382, 113291 family)', () => {
    expect(
      restatedValueAfter(
        mk(
          197720,
          484414,
          286694,
          'BGN',
          'Общата стойност на договор № 447 се променя от 197 720.00 лева без ДДС на 286 694,00 (двеста осемдесет и шест хиляди) лева без ДДС',
        ),
      ),
    ).toBe(286694);
    expect(
      restatedValueAfter(
        mk(
          13662405.12,
          28356190.64,
          14693785.52,
          'BGN',
          'в чл. 7 (1) от Договора общата цена за изпълнение предмета на договора се променя от 13 662 405,12 лв. без ДДС на 14 693 785,52 лв. без ДДС',
        ),
      ),
    ).toBe(14693785.52);
  });

  it('does NOT restate "в размер на / ресурс / increment" phrasings — they name the change, not the total', () => {
    // Real corpus 271148→650754: "…максималния ресурс за изменението в размер на 379 606.50" names the
    // INCREMENT; restating value_after to it would understate a genuine >100% increase. Must be `none`.
    expect(
      classifyAmendmentValue(
        mk(
          271147.5,
          650754,
          379606.5,
          'BGN',
          'Срокът се удължава до изчерпване на максималния ресурс за изменението в размер на 379 606.50 лв. без ДДС',
        ),
      ).kind,
    ).toBe('none');
    // "…или сума в размер на 86 363.08" — the added-work amount, not the new contract total.
    expect(
      restatedValueAfter(
        mk(
          71969.23,
          151662.82,
          79693.59,
          'BGN',
          'Общата стойност на договорените СМР се променя от 71 969.23 без ДДС или сума в размер на 79 693.59 лв.',
        ),
      ),
    ).toBeNull();
  });

  it('restates a currency re-denomination that doubled an unchanged total (189325)', () => {
    const t = classifyAmendmentValue(
      mk(
        77000000,
        154000000,
        77000000,
        'BGN',
        'Считано от 01.10.2025 г., отпечатваната върху акцизните бандероли продажна цена се променя от лева в евро.',
      ),
    );
    expect(t).toEqual({ kind: 'unchanged_restated', correctedAfter: 77000000 });
  });

  it('does NOT touch a genuine increment announced as "…с <delta>" (108677)', () => {
    const input = mk(
      10226.85,
      60226.85,
      50000,
      'EUR',
      'Увеличава се финансовият ресурс на договор № АО – 05 – 168 с 50 000 /петдесет хиляди/ евро без ДДС.',
    );
    expect(isGenuineIncrement(input)).toBe(true);
    expect(restatedValueAfter(input)).toBeNull();
  });

  it('does NOT restate an exact-2× when the text announces a DIFFERENT total ("до 18 900") — flag, not rewrite (103903)', () => {
    // #307: exact 2× (delta 15 120 = value_before) BUT the text says the value rose "до 18 900" — it is NOT
    // unchanged. Neither the doubled 30 240 nor the halved 15 120 is the true total, and 18 900 is not
    // recoverable here, so return `none` and let the arithmetic annex_total_suspect flag exclude the row.
    const t = classifyAmendmentValue(
      mk(
        15120,
        30240,
        15120,
        'BGN',
        'Прогнозната стойност по договора се увеличава от 15 120 лв. без ДДС до 18 900 лв. без ДДС',
      ),
    );
    expect(t).toEqual({ kind: 'none' });
  });

  it('does NOT text-freely restate an exact-2× when the основание carries no restatement signal (84818)', () => {
    // #307: restructuring note with no value/unchanged signal. A text-free halving could erase a legitimate
    // ЗОП чл.116 ал.1 т.1 in-scope +100% (pre-announced option clause), so it must fall to the arithmetic
    // annex_total_suspect flag (exclude), not be rewritten to the before-value.
    const t = classifyAmendmentValue(
      mk(
        76769540.87,
        153539081.74,
        76769540.87,
        'EUR',
        'Следните курсове за 22 пилота се преструктурират и се изпълняват в рамките на гаранционния период',
      ),
    );
    expect(t).toEqual({ kind: 'none' });
  });

  it('restates an exact-2× administrative annex (non-value change) to the before-value', () => {
    const t = classifyAmendmentValue(
      mk(
        2685,
        5370,
        2685,
        'BGN',
        'Променя се упълномощеното лице по договора. Несъществени промени.',
      ),
    );
    expect(t).toEqual({ kind: 'unchanged_restated', correctedAfter: 2685 });
  });

  it('does NOT text-freely restate an exact-2× on an outside-ЗОП exception contract', () => {
    // ЗОП чл.116's +50% cap does not bind exception contracts, so an exact +100% there can be a genuine
    // increase — the text-free rule 3 must stand down and let the arithmetic flag exclude (not rewrite) it.
    const base = mk(
      2685,
      5370,
      2685,
      'BGN',
      'Променя се упълномощеното лице по договора. Несъществени промени.',
    );
    expect(classifyAmendmentValue({ ...base, outsideZop: true }).kind).toBe('none');
    // …but the same row in-scope of ЗОП is still restated (guard is scoped to rule 3 only).
    expect(classifyAmendmentValue({ ...base, outsideZop: false })).toEqual({
      kind: 'unchanged_restated',
      correctedAfter: 2685,
    });
  });

  it('still applies the text-confirmed rules on an outside-ЗОП contract', () => {
    // The double-count is a feed defect independent of ЗОП scope, so a text-confirmed total is corrected
    // even for an exception contract — only the text-free exact-2× fallback is gated by outsideZop.
    const total = {
      ...mk(
        442000,
        981240,
        539240,
        'BGN',
        'общата стойност на договора ще възлезе на 539 240.00 лв.',
      ),
      outsideZop: true,
    };
    expect(classifyAmendmentValue(total)).toEqual({
      kind: 'total_restated',
      correctedAfter: 539240,
    });
    const incr = {
      ...mk(10226.85, 60226.85, 50000, 'EUR', 'Увеличава се ресурсът с 50 000 евро без ДДС.'),
      outsideZop: true,
    };
    expect(isGenuineIncrement(incr)).toBe(true);
  });

  it('ignores normal increases (< 2×) and non-self-consistent rows', () => {
    expect(classifyAmendmentValue(mk(100, 130, 30, 'BGN', 'обща стойност на 130 лв.')).kind).toBe(
      'none',
    );
    // a ≠ b + d ⇒ the double-count model does not apply
    expect(classifyAmendmentValue(mk(100, 250, 100, 'BGN', 'обща стойност на 100')).kind).toBe(
      'none',
    );
  });

  it('requires the text figure to actually equal the delta (no coincidental match)', () => {
    // delta 500000 appears nowhere as a total; a different figure 12345 does — must not restate.
    expect(
      restatedValueAfter(mk(400000, 900000, 500000, 'BGN', 'обща стойност на 12 345 лв.')),
    ).toBeNull();
  });

  it('does NOT restate a bare "…на <N>" over a NON-monetary number (#307 HIGH-1 — days / article nos.)', () => {
    // "…удължава на 200 дни": 200 is a day count that coincidentally == value_delta. Without a currency
    // anchor around the figure it must stay `none`, never overwrite the published 300 with 200.
    expect(
      classifyAmendmentValue(mk(100, 300, 200, 'BGN', 'Срокът на договора се удължава на 200 дни.'))
        .kind,
    ).toBe('none');
    // An article number after "на" — non-monetary, must not restate.
    expect(
      classifyAmendmentValue(
        mk(100, 300, 200, 'BGN', 'Договорът се изменя на 200 съгласно чл. 116 на ЗОП.'),
      ).kind,
    ).toBe('none');
  });

  it('does NOT anchor a day-count on a currency token elsewhere in the sentence (#307 MONEY_AFTER window)', () => {
    // "…удължава на 200 дни, стойността остава 100 лв.": 200 is a DAY count; the "лв." belongs to a
    // different figure downstream. A non-monetary unit right after 200 must veto it, not restate 300→200.
    expect(
      classifyAmendmentValue(
        mk(100, 300, 200, 'BGN', 'Срокът се удължава на 200 дни, стойността остава 100 лв.'),
      ).kind,
    ).toBe('none');
    expect(
      classifyAmendmentValue(
        mk(
          100,
          300,
          200,
          'BGN',
          'Срокът за изпълнение на договора се удължава на 200 дни, без промяна в договорената сума в лв.',
        ),
      ).kind,
    ).toBe('none');
  });

  it('vetoes the QUALIFIED day/quantity unit, not just the bare word (#307 review — работни/календарни дни class)', () => {
    // The unit almost never comes bare in real annexes ("работни дни", "календарни дни", "200 (двеста)
    // дни", "кв.м"). Each of these is a duration/quantity that coincidentally == value_delta; none may
    // overwrite the published 300 with 200. Tests the error CLASS, not one literal sentence.
    const dayCounts = [
      'Срокът се удължава на 200 работни дни, стойността остава 100 лв.',
      'Срокът се удължава на 200 календарни дни, стойността остава 100 лв.',
      'Срокът се удължава на 200 работни дни, без промяна в договорената сума в лв.',
      'Срокът се удължава на 200 к.д., стойността остава 100 лв.',
      'Срокът се удължава на 200 (двеста) дни, стойността остава 100 лв.',
      'Срокът се удължава на 200 р.д., стойността остава 100 лв.',
      'Площта се увеличава на 200 кв.м, стойността остава 100 лв.',
      'Обемът се увеличава на 200 куб.м, стойността остава 100 лв.',
    ];
    for (const text of dayCounts) {
      expect(classifyAmendmentValue(mk(100, 300, 200, 'BGN', text)).kind).toBe('none');
    }
  });

  it('the wider unit veto does NOT swallow a real monetary total (#307 review — reverse direction)', () => {
    // A qualified/adjacent-word unit veto must not fire on genuine money phrasings: the figure still
    // restates to the announced total. Guards against the veto over-reaching.
    const realTotals = [
      'Общата стойност на договора възлиза на 200 лв. без ДДС.',
      'Общата стойност на договора възлиза на 200 лева.',
      'Новата обща стойност възлиза на 200 лв. за срок от 12 месеца.',
      'Общата стойност се увеличава на 200 лева месечно.',
      'Общата стойност възлиза на 200 лв. и срокът се удължава с 30 работни дни.',
    ];
    for (const text of realTotals) {
      expect(restatedValueAfter(mk(100, 300, 200, 'BGN', text))).toBe(200);
    }
  });

  it('does NOT restate an exact-2× on a bare payment-in-euro clause (#307 в-евро narrowing)', () => {
    // "Плащанията…се извършват в евро…" is a payment-currency clause, NOT an unchanged-value signal — it
    // must not halve a real +100%. Only "X в евро" re-denomination phrasing may restate (see 189325).
    const t = classifyAmendmentValue(
      mk(
        250000,
        500000,
        250000,
        'BGN',
        'Плащанията по договора се извършват в евро по сметка на изпълнителя.',
      ),
    );
    expect(t).toEqual({ kind: 'none' });
  });

  it('restates a bare "…на <N>" only WHEN a currency unit follows the figure (#307 HIGH-1 anchor)', () => {
    // Same "…на <N>" shape as the days case, but a currency unit anchors it as money ⇒ genuine total.
    expect(
      restatedValueAfter(
        mk(100, 300, 200, 'BGN', 'Общата стойност на договора се променя на 200 лв. без ДДС.'),
      ),
    ).toBe(200);
  });

  it('does NOT rewrite an exact-2× with empty / whitespace-only texts (#307 HIGH-2 repro)', () => {
    const t = classifyAmendmentValue({
      valueBefore: 539240,
      valueAfter: 1078480,
      valueDelta: 539240,
      currency: 'BGN',
      texts: [null, '', '   '],
      outsideZop: null,
    });
    expect(t).toEqual({ kind: 'none' });
  });

  it('does NOT rewrite an exact-2× when the text is unrelated to value (#307 HIGH-2 repro)', () => {
    const t = classifyAmendmentValue({
      valueBefore: 250000,
      valueAfter: 500000,
      valueDelta: 250000,
      currency: 'BGN',
      outsideZop: false,
      texts: ['Смяна на адреса за кореспонденция на изпълнителя.'],
    });
    expect(t).toEqual({ kind: 'none' });
  });

  it('parses a dot-thousands + comma-decimal figure "1.234,56" (#305 number-format recall)', () => {
    // Mixed-separator total announced as "…на 1.234,56 лв." — the resolver must read 1234.56, not 1.23.
    expect(
      restatedValueAfter(
        mk(700, 1934.56, 1234.56, 'BGN', 'Общата стойност на договора се променя на 1.234,56 лв.'),
      ),
    ).toBe(1234.56);
    // …and the US ordering "1,234.56" resolves to the same value.
    expect(
      restatedValueAfter(
        mk(700, 1934.56, 1234.56, 'BGN', 'Общата стойност на договора се променя на 1,234.56 лв.'),
      ),
    ).toBe(1234.56);
  });
});
