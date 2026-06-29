import { money, count } from '@sigma/shared';

export function buildContractCitation(c: {
  subject: string;
  authority: { name: string };
  bidder: { displayName: string };
  value: { currentEur: number | null };
  id: string;
}): string {
  return [
    `Договор: ${c.subject}`,
    `Възложител: ${c.authority.name}`,
    `Изпълнител: ${c.bidder.displayName}`,
    `Стойност: ${money(c.value.currentEur)}`,
    `Връзка: https://sigma.midt.bg/contracts/${c.id}`,
  ].join('\n');
}

export function buildCompanyCitation(c: {
  displayName: string;
  eik: string | null;
  wonEur: number;
  contracts: number;
  slug: string;
}): string {
  return [
    `Компания: ${c.displayName}`,
    `ЕИК: ${c.eik || 'Няма'}`,
    `Общо спечелено: ${money(c.wonEur)}`,
    `Брой договори: ${count(c.contracts)}`,
    `Връзка: https://sigma.midt.bg/companies/${c.slug}`,
  ].join('\n');
}

export function buildAuthorityCitation(a: {
  name: string;
  spentEur: number;
  contracts: number;
  slug: string;
}): string {
  return [
    `Институция: ${a.name}`,
    `Общо похарчено: ${money(a.spentEur)}`,
    `Брой договори: ${count(a.contracts)}`,
    `Връзка: https://sigma.midt.bg/authorities/${a.slug}`,
  ].join('\n');
}
