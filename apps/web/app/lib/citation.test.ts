import { describe, it, expect } from 'vitest';
import { buildContractCitation, buildCompanyCitation, buildAuthorityCitation } from './citation';
import { money } from '@sigma/shared';

describe('citation builders', () => {
  it('builds a contract citation', () => {
    const c = {
      subject: 'Доставка на компютри',
      authority: { name: 'Община Пловдив' },
      bidder: { displayName: 'Техно ООД' },
      value: { currentEur: 125000.5 },
      id: 'abc-123',
    };

    const citation = buildContractCitation(c);
    expect(citation).toBe(
      [
        'Договор: Доставка на компютри',
        'Възложител: Община Пловдив',
        'Изпълнител: Техно ООД',
        `Стойност: ${money(125000.5)}`,
        'Връзка: https://sigma.midt.bg/contracts/abc-123',
      ].join('\n'),
    );
  });

  it('handles contract with null value', () => {
    const c = {
      subject: 'Одит',
      authority: { name: 'Община Пловдив' },
      bidder: { displayName: 'Техно ООД' },
      value: { currentEur: null },
      id: 'abc-123',
    };

    const citation = buildContractCitation(c);
    expect(citation).toBe(
      [
        'Договор: Одит',
        'Възложител: Община Пловдив',
        'Изпълнител: Техно ООД',
        'Стойност: —',
        'Връзка: https://sigma.midt.bg/contracts/abc-123',
      ].join('\n'),
    );
  });

  it('builds a company citation with EIK', () => {
    const c = {
      displayName: 'Техно ООД',
      eik: '123456789',
      wonEur: 5000000,
      contracts: 42,
      slug: 'techno-ood',
    };

    const citation = buildCompanyCitation(c);
    expect(citation).toBe(
      [
        'Компания: Техно ООД',
        'ЕИК: 123456789',
        `Общо спечелено: ${money(5000000)}`,
        'Брой договори: 42',
        'Връзка: https://sigma.midt.bg/companies/techno-ood',
      ].join('\n'),
    );
  });

  it('builds a company citation without EIK', () => {
    const c = {
      displayName: 'Чуждестранна фирма',
      eik: null,
      wonEur: 0,
      contracts: 1,
      slug: 'foreign-corp',
    };

    const citation = buildCompanyCitation(c);
    expect(citation).toBe(
      [
        'Компания: Чуждестранна фирма',
        'ЕИК: Няма',
        `Общо спечелено: ${money(0)}`,
        'Брой договори: 1',
        'Връзка: https://sigma.midt.bg/companies/foreign-corp',
      ].join('\n'),
    );
  });

  it('builds an authority citation', () => {
    const a = {
      name: 'Община Варна',
      spentEur: 1000000,
      contracts: 5,
      slug: 'obshtina-varna',
    };

    const citation = buildAuthorityCitation(a);
    expect(citation).toBe(
      [
        'Институция: Община Варна',
        `Общо похарчено: ${money(1000000)}`,
        'Брой договори: 5',
        'Връзка: https://sigma.midt.bg/authorities/obshtina-varna',
      ].join('\n'),
    );
  });
});
