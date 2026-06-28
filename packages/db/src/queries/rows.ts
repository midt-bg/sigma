// Rollup row shapes (company_totals / authority_totals) and their mappers to api-contract DTOs.
// Shared by the home slice and the leaderboard list pages so the mapping lives once.

import type {
  AuthorityListItem,
  CompanyListItem,
  EntityKind,
  OwnershipKind,
} from '@sigma/api-contract';
import { ENTITY_TYPES } from '@sigma/config';
import { cleanName, entityName, type Locale } from '@sigma/shared';
import { authoritySlug, companySlug } from './identity';
import { sectorRef } from './sectors';

// Friendly authority type_group → display label (the bucket keys are themselves Bulgarian words;
// a couple read better expanded in the chip).
const TYPE_LABELS: Record<string, string> = {
  министерство: 'министерство',
  община: 'община',
  агенция: 'агенция',
  болница: 'болница',
  образование: 'образование',
  'държавна компания': 'държ. компания',
  друго: 'друго',
};

const TYPE_LABELS_EN: Record<string, string> = {
  министерство: 'Ministry',
  община: 'Municipality',
  агенция: 'Agency',
  болница: 'Hospital',
  образование: 'Education',
  'държавна компания': 'State company',
  друго: 'Other',
};

export function typeLabel(typeGroup: string | null, locale: Locale): string | null {
  if (!typeGroup) return null;
  const map = locale === 'en' ? TYPE_LABELS_EN : TYPE_LABELS;
  return map[typeGroup] ?? typeGroup;
}

export interface CompanyTotalsRow {
  bidder_id: string;
  name: string;
  kind: EntityKind;
  ownership_kind: OwnershipKind | null;
  eik: string | null;
  eik_valid: number;
  settlement: string | null;
  won_eur: number;
  contracts: number;
  authorities: number;
  primary_sector: string | null;
  eu_eur: number;
  first_date: string | null;
  last_date: string | null;
}

export function toCompanyListItem(r: CompanyTotalsRow, locale: Locale): CompanyListItem {
  const hasEik = r.eik_valid === 1 && Boolean(r.eik);
  return {
    slug: companySlug(r.bidder_id),
    name: cleanName(r.name),
    displayName: entityName(cleanName(r.name), r.kind, locale),
    kind: r.kind,
    isConsortium: r.kind === 'consortium',
    eik: r.eik,
    eikValid: r.eik_valid === 1,
    hasEik,
    ownershipKind: r.ownership_kind,
    settlement: r.settlement,
    sector: sectorRef(r.primary_sector, locale),
    wonEur: r.won_eur,
    contracts: r.contracts,
    authorities: r.authorities,
  };
}

export interface AuthorityTotalsRow {
  authority_id: string;
  name: string;
  type_group: string | null;
  settlement: string | null;
  region: string | null;
  spent_eur: number;
  contracts: number;
  suppliers: number;
  avg_eur: number;
  primary_sector: string | null;
  eu_eur: number;
  first_date: string | null;
  last_date: string | null;
}

export function toAuthorityListItem(r: AuthorityTotalsRow, locale: Locale): AuthorityListItem {
  return {
    slug: authoritySlug(r.authority_id),
    name: cleanName(r.name),
    typeGroup: r.type_group,
    typeLabel: typeLabel(r.type_group, locale),
    settlement: r.settlement,
    spentEur: r.spent_eur,
    contracts: r.contracts,
    avgEur: r.avg_eur,
  };
}

export { ENTITY_TYPES };
