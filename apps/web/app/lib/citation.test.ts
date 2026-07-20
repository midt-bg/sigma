import { describe, it, expect } from 'vitest';
import { buildContractCitation, buildCompanyCitation, buildAuthorityCitation } from './citation';

describe('citation builders', () => {
  it('builds a contract citation', () => {
    const c = {
      subject: 'Доставка на компютри',
      authority: { name: 'Община Пловдив' },
      bidder: { displayName: 'Техно ООД' },
      value: { currentEur: 125000.5 },
      id: 'abc-123',
    };

    const citation = buildContractCitation(c, 'https://sigma.test');
    expect(citation).toBe(
      [
        'Договор: Доставка на компютри',
        'Възложител: Община Пловдив',
        'Изпълнител: Техно ООД',
        'Стойност: 125 хил. €',
        'Връзка: https://sigma.test/contracts/abc-123',
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

    const citation = buildContractCitation(c, 'https://sigma.test');
    expect(citation).toBe(
      [
        'Договор: Одит',
        'Възложител: Община Пловдив',
        'Изпълнител: Техно ООД',
        'Стойност: —',
        'Връзка: https://sigma.test/contracts/abc-123',
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

    const citation = buildCompanyCitation(c, 'https://sigma.test');
    expect(citation).toBe(
      [
        'Компания: Техно ООД',
        'ЕИК: 123456789',
        'Общо спечелено: 5 млн. €',
        'Брой договори: 42',
        'Връзка: https://sigma.test/companies/techno-ood',
      ].join('\n'),
    );
  });

  it('handles contract with no awarded bidder', () => {
    const c = {
      subject: 'Прекратена процедура',
      authority: { name: 'Община Пловдив' },
      bidder: null,
      value: { currentEur: null },
      id: 'abc-123',
    };

    const citation = buildContractCitation(c, 'https://sigma.test');
    expect(citation).toBe(
      [
        'Договор: Прекратена процедура',
        'Възложител: Община Пловдив',
        'Изпълнител: —',
        'Стойност: —',
        'Връзка: https://sigma.test/contracts/abc-123',
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

    const citation = buildCompanyCitation(c, 'https://sigma.test');
    expect(citation).toBe(
      [
        'Компания: Чуждестранна фирма',
        'ЕИК: Няма',
        'Общо спечелено: 0 €',
        'Брой договори: 1',
        'Връзка: https://sigma.test/companies/foreign-corp',
      ].join('\n'),
    );
  });

  it('leaves the EIK line blank for an empty string, since ?? only catches null', () => {
    const c = {
      displayName: 'Празен ЕИК ЕООД',
      eik: '',
      wonEur: 250000,
      contracts: 3,
      slug: 'prazen-eik-eood',
    };

    const citation = buildCompanyCitation(c, 'https://sigma.test');
    expect(citation).toBe(
      [
        'Компания: Празен ЕИК ЕООД',
        'ЕИК: ',
        'Общо спечелено: 250 хил. €',
        'Брой договори: 3',
        'Връзка: https://sigma.test/companies/prazen-eik-eood',
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

    const citation = buildAuthorityCitation(a, 'https://sigma.test');
    expect(citation).toBe(
      [
        'Институция: Община Варна',
        'Общо похарчено: 1 млн. €',
        'Брой договори: 5',
        'Връзка: https://sigma.test/authorities/obshtina-varna',
      ].join('\n'),
    );
  });
});
