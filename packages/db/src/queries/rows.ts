// Rollup row shapes (company_totals / authority_totals) and their mappers to api-contract DTOs.
// Shared by the home slice and the leaderboard list pages so the mapping lives once.

import type {
  AuthorityListItem,
  CompanyListItem,
  EntityKind,
  OwnershipKind,
} from '@sigma/api-contract';
import { ENTITY_TYPES } from '@sigma/config';
import {
  MASKED_NATURAL_PERSON_LABEL,
  cleanName,
  entityName,
  isNaturalPersonBidder,
} from '@sigma/shared';
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

export function typeLabel(typeGroup: string | null): string | null {
  if (!typeGroup) return null;
  return TYPE_LABELS[typeGroup] ?? typeGroup;
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
  legal_form: string | null;
}

export function toCompanyListItem(r: CompanyTotalsRow): CompanyListItem {
  // Privacy (PR #183 review): a sole trader / natural person has the same `ЕТ` / sole-trader signal
  // in the rollup as on the detail page and in the CSV/JSON exports. Mask ЕИК and the source name
  // here so /companies, /companies.data (RRv7 single-fetch twin), and the home top-10 all carry
  // the masked values — they share this mapper, so the new branch covers all three in one place.
  //
  // Consortium guard mirrors the CSV streamer (`bidder_kind !== 'consortium' && isNaturalPersonBidder(...)`
  // in companies.ts): isNaturalPersonBidder's docstring delegates JV filtering to the caller, so a
  // consortium whose first member is a sole trader (e.g. "ЕТ Иван Петров; Строй ООД") would
  // otherwise over-mask — losing the "… и др." shape and the consortium ЕИК. The guard keeps the
  // JV's name + ЕИК verbatim.
  //
  // The unmasked name is also held back from `displayName`: a masked row must read "Частно лице"
  // everywhere on the list page (and on the home page) — exposing the masked `displayName` next
  // to a null ЕИК would let a crawler infer the natural-person class without needing the ЕИК.
  const isNaturalPerson =
    r.kind !== 'consortium' && isNaturalPersonBidder(cleanName(r.name), r.legal_form);
  const name = isNaturalPerson ? MASKED_NATURAL_PERSON_LABEL : cleanName(r.name);
  return {
    slug: companySlug(r.bidder_id),
    name,
    displayName: isNaturalPerson ? MASKED_NATURAL_PERSON_LABEL : entityName(name, r.kind),
    kind: r.kind,
    isConsortium: r.kind === 'consortium',
    eik: isNaturalPerson ? null : r.eik,
    eikValid: r.eik_valid === 1,
    hasEik: isNaturalPerson ? false : r.eik_valid === 1 && Boolean(r.eik),
    ownershipKind: r.ownership_kind,
    settlement: r.settlement,
    sector: sectorRef(r.primary_sector),
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

export function toAuthorityListItem(r: AuthorityTotalsRow): AuthorityListItem {
  return {
    slug: authoritySlug(r.authority_id),
    name: cleanName(r.name),
    typeGroup: r.type_group,
    typeLabel: typeLabel(r.type_group),
    settlement: r.settlement,
    spentEur: r.spent_eur,
    contracts: r.contracts,
    avgEur: r.avg_eur,
  };
}

export { ENTITY_TYPES };
