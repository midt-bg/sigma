import type { ContractValueTimeline } from '@sigma/api-contract';
import { money, pct } from '@sigma/shared';

// Copy for a contract whose published value we do not trust.
//
// The corpus has 5 450 `value_low` contracts and every one of them carries a populated, summed
// figure — so the number sits on the page looking exactly like a trustworthy one. Until now the only
// marking was a grey italic line under a 32px serif figure, and its wording („стойност с непотвърдена
// достоверност") sounded like OUR uncertainty. It is not: the number is published that way by ЦАИС
// ЕОП and looks wrong at the source. The copy has to say that, with the actual figures.
//
// The verdicts also need different sentences, which is why the DTO carries `flag` and not just
// `suspect`. Notably `value_low` is decided on the SIGNING value while the label is rendered next to
// the CURRENT one; 73 contracts are therefore flagged „too low" while displaying ≥100 000 € (the
// extreme: signed for 0,01 лв., current 37 млн. лв.). Calling that „a low value" is misleading — the
// story there is the jump, so it gets its own sentence.

/** One-line marker copy for list rows, where there is no room for the full explanation. Same wording
 *  in every list so the mark means one thing across the site. */
export const UNVERIFIED_HINT = 'стойността в източника изглежда грешна';

export interface UnverifiedValueNote {
  /** Heading for the explanation block. Varies with the verdict: most cases are a source defect, but
   *  the catch-all ones are honestly ours („does not pass our checks"), so the title must not claim
   *  more than the sentence under it. */
  title: string;
  /** Short uppercase marker rendered next to the figure itself. */
  badge: string;
  /** Which figure in the strip the marker belongs on. `annex_total_suspect` is a statement about the
   *  CURRENT value only — the signing value is fine and must not be smeared with it. */
  scope: 'signing' | 'current' | 'both';
  /** One sentence naming what looks wrong, with the concrete figures where we have them. */
  headline: string;
  /** Who published it and what we did (nothing) — the „input data" half of the message. */
  detail: string;
}

/** How many times the current value must exceed the signing value before `value_low` is reported as a
 *  jump rather than as a low value. Deliberately blunt: the point is only to stop describing a
 *  19-million-euro figure as „too low". */
const JUMP_RATIO = 10;

/** The share of the forecast below which `refresh-slice.sql` calls a signing value implausible. Kept
 *  in sync with the rule there by hand; it exists here only so the sentence and the rule agree. */
const LOW_VALUE_SHARE = 0.05;

export function unverifiedValueNote(v: ContractValueTimeline): UnverifiedValueNote | null {
  if (!v.suspect && !v.currentValueDoubled) return null;

  const SOURCE = 'Числото е публикувано така от ЦАИС ЕОП. СИГМА не коригира входните данни.';

  if (v.currentValueDoubled) {
    return {
      title: 'Текущата стойност изглежда отчетена двойно',
      badge: 'двойно отчетена',
      scope: 'current',
      headline:
        'Текущата стойност изглежда отчетена два пъти в източника, затова не се показва — известно грешно число заблуждава повече от честна празнина.',
      detail: SOURCE,
    };
  }

  const jumped =
    v.flag === 'value_low' &&
    v.signingEur != null &&
    v.signingEur > 0 &&
    v.currentEur != null &&
    v.currentEur / v.signingEur >= JUMP_RATIO;

  if (jumped) {
    return {
      title: 'Двете стойности не се връзват една с друга',
      badge: 'скок след изменения',
      scope: 'both',
      headline: `Стойността при сключване (${money(v.signingEur!)}) и текущата (${money(v.currentEur!)}) се разминават в пъти — едната от двете е сгрешена при подаването.`,
      detail: SOURCE,
    };
  }

  if (v.flag === 'value_low') {
    // `value_low` covers two different source defects: a non-positive value, and a value that is a
    // rounding error next to the forecast. Only claim the ratio when it actually holds — the rule also
    // fires on `COALESCE(current, signing) <= 0`, where there is no percentage to quote.
    const nonPositive = v.signingEur != null && v.signingEur <= 0;
    const ratio =
      v.signingEur != null && v.estimatedEur != null && v.estimatedEur > 0
        ? v.signingEur / v.estimatedEur
        : null;
    const observed = nonPositive
      ? `Публикуваната стойност на договора е ${money(v.signingEur)}.`
      : ratio != null && ratio < LOW_VALUE_SHARE
        ? `Публикуваната стойност е ${money(v.signingEur)} при прогнозна ${money(v.estimatedEur)} — под ${pct(LOW_VALUE_SHARE, 0)} от нея.`
        : `Публикуваната стойност (${money(v.signingEur)}) е несъразмерно ниска спрямо прогнозната.`;
    return {
      title: 'Стойността изглежда сгрешена в източника',
      badge: 'вероятно грешна стойност',
      scope: 'both',
      headline: `${observed} Обичайно това е единична цена (лв./км, лв./час) или заместващ текст, попаднал в полето за стойност на договора.`,
      detail: SOURCE,
    };
  }

  return {
    title: 'Стойността не е потвърдена',
    badge: 'непотвърдена стойност',
    scope: 'both',
    headline:
      'Стойността се разминава с останалите данни по договора и не издържа проверките ни за достоверност.',
    detail: SOURCE,
  };
}
