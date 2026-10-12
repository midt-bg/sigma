import { describe, expect, it } from 'vitest';
import type { PublicStake } from '@sigma/db';
import { hasPublicStake, publicStakeLabels } from './public-stake';

const stake = (over: Partial<PublicStake>): PublicStake => ({
  listed: null,
  derived: null,
  direct: [],
  indirect: [],
  ...over,
});

describe('the public stake under a company’s name', () => {
  it('names a company held whole by the state, a municipality or the central bank', () => {
    expect(publicStakeLabels(stake({ direct: [{ name: 'М', kind: 'state', pct: 100 }] }))).toEqual([
      'Държавно дружество',
    ]);
    expect(
      publicStakeLabels(stake({ direct: [{ name: 'О', kind: 'municipal', pct: 100 }] })),
    ).toEqual(['Общинско дружество']);
    expect(publicStakeLabels(stake({ direct: [{ name: 'Б', kind: 'bnb', pct: 100 }] }))).toEqual([
      'Дружество на БНБ',
    ]);
  });

  it('gives a part as its share, summed by owner kind, and keeps each kind apart', () => {
    expect(publicStakeLabels(stake({ direct: [{ name: 'Б', kind: 'bnb', pct: 25 }] }))).toEqual([
      '25% участие на БНБ',
    ]);
    expect(
      publicStakeLabels(
        stake({
          direct: [
            { name: 'О1', kind: 'municipal', pct: 20 },
            { name: 'О2', kind: 'municipal', pct: 15.5 },
            { name: 'М', kind: 'state', pct: 10 },
          ],
        }),
      ),
    ).toEqual(['35,5% общинско участие', '10% държавно участие']);
    expect(publicStakeLabels(stake({ direct: [{ name: 'Б', kind: 'mixed', pct: 40 }] }))).toEqual([
      '40% публично участие',
    ]);
  });

  it('never makes an unknown share a number', () => {
    expect(
      publicStakeLabels(stake({ direct: [{ name: 'О', kind: 'municipal', pct: null }] })),
    ).toEqual(['Общинско участие']);
    for (const kind of ['state', 'bnb', 'mixed'] as const)
      expect(publicStakeLabels(stake({ direct: [{ name: 'X', kind, pct: null }] }))[0]).not.toMatch(
        /\d/,
      );
  });

  it('says a stake through another company is indirect, and adds it to nothing', () => {
    expect(
      publicStakeLabels(
        stake({
          direct: [{ name: 'М', kind: 'state', pct: 10 }],
          indirect: [
            { name: 'ТЕСТ ХОЛДИНГ ЕАД', kind: 'state', pct: 100 },
            { name: 'ТЕСТ АД', kind: 'bnb', pct: null },
          ],
        }),
      ),
    ).toEqual([
      '10% държавно участие',
      'Косвено 100% чрез ТЕСТ ХОЛДИНГ ЕАД',
      'Косвено чрез ТЕСТ АД',
    ]);
  });

  it('falls back to the Agency list with no owner on record, and says nothing without a stake', () => {
    expect(publicStakeLabels(stake({ listed: 'state' }))).toEqual([
      'Държавно публично предприятие',
    ]);
    expect(publicStakeLabels(stake({ derived: 'municipal' }))).toEqual([
      'Общинско публично предприятие',
    ]);
    expect(publicStakeLabels(stake({ listed: 'mixed' }))).toEqual(['Публично предприятие']);
    expect(publicStakeLabels(undefined)).toEqual([]);
    expect(hasPublicStake(stake({}))).toBe(false);
    expect(hasPublicStake(stake({ listed: 'state' }))).toBe(true);
  });
});
