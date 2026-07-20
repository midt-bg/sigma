import { MASKED_NATURAL_PERSON_LABEL, isNaturalPersonBidder } from '@sigma/shared';
import type { ContractRecord } from '@sigma/api-contract';
import { contractIdFromSlug, getContract } from '@sigma/db';
import type { Route } from './+types/contract.json';
import { publicCache } from '../lib/cache';
import { withDataSource } from '../lib/dataSource';
import { markPrivacyMaskApplied } from '../lib/security';

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/<\//g, '<\\/');
}

/**
 * Pure natural-person mask for the `/contracts/:id.json` body. Returns a copy of `record` with
 * the bidder's ЕИК cleared and the bidder name (incl. `displayName` and `sourceNames.bidder`)
 * replaced by the canonical masking label when `isNaturalPersonBidder(name, bidderLegalForm)`
 * matches. Returns the input by reference when the record identifies a legal entity, so callers
 * can use reference equality to decide whether to set the noindex header.
 */
export function maskContractForPrivacy(
  record: ContractRecord & { bidder_legal_form: string | null },
  bidderLegalForm: string | null,
): ContractRecord {
  if (!isNaturalPersonBidder(record.bidder.name, bidderLegalForm)) return record;
  return {
    ...record,
    bidder: {
      ...record.bidder,
      eik: null,
      name: MASKED_NATURAL_PERSON_LABEL,
      displayName: MASKED_NATURAL_PERSON_LABEL,
    },
    sourceNames: {
      ...record.sourceNames,
      bidder: MASKED_NATURAL_PERSON_LABEL,
    },
  };
}

// Resource route: the assembled contract record as machine-readable JSON (/contracts/:id.json).
export async function loader({ params, context }: Route.LoaderArgs) {
  const id = (params.id ?? '').replace(/\.json$/, '');
  const record = await getContract(context.cloudflare.env.DB, contractIdFromSlug(id));
  if (!record) return withDataSource(Response.json({ error: 'not_found' }, { status: 404 }));
  const masked = maskContractForPrivacy(record, record.bidder_legal_form);
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': publicCache(3600),
  });
  if (masked !== record) markPrivacyMaskApplied(headers);
  return withDataSource(new Response(safeJson(masked), { headers }));
}
