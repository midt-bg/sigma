import { count, plural } from '@sigma/shared';

/** A profile's „Брой договори": the summed contracts (authority_totals / company_totals), plus the two kinds of
 *  row its contracts list also shows but the sums leave out. */
export interface ProfileContractCounts {
  contracts: number;
  missingValue: number;
  frameworkAgreements: number;
}

/** The size of the party's contracts list (/contracts?authority= or ?bidder=): every row, with or without a value. */
export function listedContracts(c: ProfileContractCounts): number {
  return c.contracts + c.missingValue + c.frameworkAgreements;
}

/**
 * The line under „Брой договори" when the list behind it is longer: which rows the count leaves out, so the
 * two numbers reconcile on the page. Undefined when they are the same number.
 */
export function contractCountNote(c: ProfileContractCounts): string | undefined {
  const listed = listedContracts(c);
  if (listed === c.contracts) return undefined;
  const left = [
    c.frameworkAgreements > 0 &&
      `${count(c.frameworkAgreements)} ${plural(c.frameworkAgreements, 'рамково споразумение', 'рамкови споразумения')}`,
    c.missingValue > 0 && `${count(c.missingValue)} без стойност`,
  ].filter(Boolean);
  return `със стойност; в списъка са ${count(listed)} — и ${left.join(' и ')}`;
}
