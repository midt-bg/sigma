import type { LoadedPersonProfile } from './person-profile.server';
import type { InterestObservation, TimelineContracts } from '@sigma/db';
import type { PersonRole, ConflictLink, PersonDeclaration } from '@sigma/api-contract';

export interface TimelineCompany {
  eik: string;
  name: string;
  href: string | null;
  roles: PersonRole[];
  links: ConflictLink[];
  observations: InterestObservation[];
  contracts: TimelineContracts[];
  declarations: PersonDeclaration[];
  asOf: string | null;
  /** A public enterprise: a role there is a held position, shown with the offices (ADR-0047). */
  publicEnterprise: boolean;
}
export function timelineCompanies(p: LoadedPersonProfile): TimelineCompany[] {
  const companies = new Map<string, TimelineCompany>();
  const get = (eik: string, name: string, href: string | null) => {
    if (!companies.has(eik))
      companies.set(eik, {
        eik,
        name,
        href,
        roles: [],
        links: [],
        observations: [],
        contracts: [],
        declarations: [],
        asOf: null,
        publicEnterprise: false,
      });
    return companies.get(eik)!;
  };
  for (const link of p.links)
    get(link.eik, link.company, `/companies/${link.eik}`).links.push(link);
  for (const role of p.person?.roles ?? [])
    get(role.company.eik, role.company.name, role.company.href).roles.push(role);
  for (const contracts of p.timeline.contracts)
    get(contracts.eik, contracts.company, `/companies/${contracts.eik}`).contracts.push(contracts);
  for (const c of companies.values()) {
    c.observations = p.timeline.observations.filter((o) => o.eik === c.eik);
    c.declarations = p.declarations.filter((d) => d.companyEiks.includes(c.eik));
    c.asOf = p.timeline.reads.find((r) => r.eik === c.eik)?.asOf ?? null;
    c.publicEnterprise = c.roles.some((r) => !!r.company.ownershipKind) && !c.links.length;
    c.roles = [
      ...new Map(c.roles.map((r) => [`${r.role}|${r.addedOn}|${r.removedOn}`, r])).values(),
    ];
  }
  return [...companies.values()].sort(
    (a, b) =>
      Number(b.publicEnterprise) - Number(a.publicEnterprise) ||
      Number(!!b.links.length) - Number(!!a.links.length) ||
      b.contracts.reduce((s, c) => s + c.eligible, 0) -
        a.contracts.reduce((s, c) => s + c.eligible, 0) ||
      a.name.localeCompare(b.name, 'bg'),
  );
}
export const positiveObservation = (o: Pick<InterestObservation, 'timing'>) =>
  ['annual', 'current'].includes(o.timing);
export function timelineYears(p: LoadedPersonProfile, companies: TimelineCompany[]) {
  const years = [
    ...p.declarations.map((d) => d.year),
    ...companies.flatMap((c) => [
      ...c.contracts.map((r) => r.year),
      ...c.observations.map((o) => o.reportedYear),
      ...c.roles.flatMap((r) => [r.addedOn?.slice(0, 4), (r.removedOn ?? c.asOf)?.slice(0, 4)]),
    ]),
  ]
    .filter((y): y is string => !!y && /^\d{4}$/.test(y) && +y >= 1900 && +y <= 2200)
    .map(Number);
  if (!years.length) return [];
  const min = Math.min(...years),
    max = Math.max(...years);
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}
