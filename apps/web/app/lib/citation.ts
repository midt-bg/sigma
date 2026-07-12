import { money, count } from '@sigma/shared';

export function buildContractCitation(
  c: {
    subject: string;
    authority: { name: string };
    bidder: { displayName: string } | null;
    value: { currentEur: number | null };
    id: string;
  },
  origin: string,
): string {
  return [
    `Договор: ${c.subject}`,
    `Възложител: ${c.authority.name}`,
    `Изпълнител: ${c.bidder ? c.bidder.displayName : '—'}`,
    `Стойност: ${money(c.value.currentEur)}`,
    `Връзка: ${origin}/contracts/${c.id}`,
  ].join('\n');
}

export function buildCompanyCitation(
  c: {
    displayName: string;
    eik: string | null;
    wonEur: number;
    contracts: number;
    slug: string;
  },
  origin: string,
): string {
  return [
    `Компания: ${c.displayName}`,
    `ЕИК: ${c.eik ?? 'Няма'}`,
    `Общо спечелено: ${money(c.wonEur)}`,
    `Брой договори: ${count(c.contracts)}`,
    `Връзка: ${origin}/companies/${c.slug}`,
  ].join('\n');
}

export function buildAuthorityCitation(
  a: {
    name: string;
    spentEur: number;
    contracts: number;
    slug: string;
  },
  origin: string,
): string {
  return [
    `Институция: ${a.name}`,
    `Общо похарчено: ${money(a.spentEur)}`,
    `Брой договори: ${count(a.contracts)}`,
    `Връзка: ${origin}/authorities/${a.slug}`,
  ].join('\n');
}
