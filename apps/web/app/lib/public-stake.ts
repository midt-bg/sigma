import type { PublicStake, PublicStakeOwner } from '@sigma/db';

const pct = (n: number) =>
  `${Number.isInteger(n) ? n : n.toLocaleString('bg-BG', { maximumFractionDigits: 2 })}%`;
const WHOLE: Record<PublicStakeOwner['kind'], string> = {
  state: 'Държавно дружество',
  municipal: 'Общинско дружество',
  bnb: 'Дружество на БНБ',
  mixed: 'Публично дружество',
};
const PART: Record<PublicStakeOwner['kind'], (share: string) => string> = {
  state: (s) => `${s} държавно участие`,
  municipal: (s) => `${s} общинско участие`,
  bnb: (s) => `${s} участие на БНБ`,
  mixed: (s) => `${s} публично участие`,
};
const UNKNOWN: Record<PublicStakeOwner['kind'], string> = {
  state: 'Държавно участие',
  municipal: 'Общинско участие',
  bnb: 'Участие на БНБ',
  mixed: 'Публично участие',
};

/**
 * The public stake under a company's name, as the sources establish it: „Държавно дружество“ when the state
 * holds all of it, „25% държавно участие“ when part; with no share given, the stake without a number — an
 * unknown share is never shown as all or none. A stake through another public company says so and is not
 * added to a direct one. On the Agency's list alone, with no owner on record, „… публично предприятие“.
 */
export function publicStakeLabels(stake: PublicStake | undefined): string[] {
  if (!stake) return [];
  const labels: string[] = [];
  const kinds = [...new Set(stake.direct.map((o) => o.kind))];
  for (const kind of kinds) {
    const owners = stake.direct.filter((o) => o.kind === kind);
    const known = owners.every((o) => o.pct !== null);
    const share = known ? owners.reduce((s, o) => s + o.pct!, 0) : null;
    if (share === null) labels.push(UNKNOWN[kind]);
    else if (share >= 100) labels.push(WHOLE[kind]);
    else labels.push(PART[kind](pct(share)));
  }
  for (const o of stake.indirect)
    labels.push(
      `Косвено ${o.pct === null ? '' : `${pct(o.pct)} `}чрез ${o.name}`.replace(/\s+/g, ' '),
    );
  if (!labels.length && (stake.listed || stake.derived)) {
    const kind = stake.listed ?? stake.derived!;
    labels.push(
      kind === 'municipal'
        ? 'Общинско публично предприятие'
        : kind === 'mixed'
          ? 'Публично предприятие'
          : 'Държавно публично предприятие',
    );
  }
  return labels;
}

/** Any public stake the sources establish, however small. */
export const hasPublicStake = (stake: PublicStake | undefined) =>
  publicStakeLabels(stake).length > 0;
