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

  it('conservatively restates an exact-2× to the before-value even when the text total differs (103903)', () => {
    // Exact 2× (delta 15 120 = value_before): the "difference" field echoed the OLD value. The true total
    // 18 900 ("…до 18 900") is a small real increase we cannot recover here (that is v2 direct-total
    // parsing), but restating to 15 120 removes the double-count and is a safe lower bound — never the
    // doubled 30 240.
    const t = classifyAmendmentValue(
      mk(
        15120,
        30240,
        15120,
        'BGN',
        'Прогнозната стойност по договора се увеличава от 15 120 лв. без ДДС до 18 900 лв. без ДДС',
      ),
    );
    expect(t).toEqual({ kind: 'unchanged_restated', correctedAfter: 15120 });
  });

  it('restates an exact-2× with no textual value signal to the before-value (84818 — restructuring)', () => {
    // The value did not change (courses restructured); ЗОП caps a single amendment at +50%, so an exact
    // +100% is a defect. Restate to the (unchanged) before value — currency-agnostic (EUR annex, BGN contract).
    const t = classifyAmendmentValue(
      mk(
        76769540.87,
        153539081.74,
        76769540.87,
        'EUR',
        'Следните курсове за 22 пилота се преструктурират и се изпълняват в рамките на гаранционния период',
      ),
    );
    expect(t).toEqual({ kind: 'unchanged_restated', correctedAfter: 76769540.87 });
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
});
