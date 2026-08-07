import { MASKED_NATURAL_PERSON_LABEL, isNaturalPersonBidder } from '@sigma/shared';
import type { ContractRecord } from '@sigma/api-contract';
import { contractIdFromSlug, getContract, getDb } from '@sigma/db';
import type { Route } from './+types/contract.json';
import { publicCache } from '../lib/cache';
import { withDataSource } from '../lib/dataSource';
import { serializeJsonForScript } from '../lib/json-ld';

/**
 * Pure natural-person mask for the `/contracts/:id.json` body. Returns a copy of `record` with
 * the bidder's ЕИК cleared and the bidder name (incl. `displayName` and `sourceNames.bidder`)
 * replaced by the canonical masking label when `isNaturalPersonBidder(name, bidderLegalForm)`
 * matches. Returns the input by reference when the record identifies a legal entity, so callers
 * can use reference equality to decide whether to set the noindex header.
 *
 * The `record.bidder.kind === 'consortium'` guard mirrors the CSV streamer
 * (`bidder_kind !== 'consortium' && isNaturalPersonBidder(...)` in contracts.ts:459): a JV whose
 * first member is a sole trader has a display name beginning "ЕТ …", so `isNaturalPersonBidder`
 * alone would over-mask the consortium to "Частно лице" — losing the "… и др." shape and the
 * consortium ЕИК. `isNaturalPersonBidder`'s docstring explicitly delegates consortium filtering
 * to the caller; the guard here is that caller (PR #183 review, MAJOR 1).
 */
export function maskContractForPrivacy(
  record: ContractRecord & { bidder_legal_form: string | null },
  bidderLegalForm: string | null,
): ContractRecord {
  if (record.bidder.kind === 'consortium') return record;
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
//
// Privacy: the natural-person masker (maskContractForPrivacy) zeros ЕИК and replaces the bidder
// name with MASKED_NATURAL_PERSON_LABEL when the bidder is a sole-trader / natural person; the
// noindex header is set in the same branch so search engines don't surface the masked identifier
// either. Mirrors the CSV streamer's `bidder_kind !== 'consortium' && isNaturalPersonBidder(...)`
// gate. JSON serialization uses the shared `serializeJsonForScript` (lib/json-ld.ts) so the
// `<`/U+2028/U+2029 escaping is consistent with the JSON-LD data island in root.tsx and the two
// can't drift. `X-Content-Type-Options: nosniff` is the MIME-sniffing guard — the worker sets it
// globally (baseSecurityHeaders), and it is set explicitly here too so this resource route is safe
// on its own, not only via the global layer.
export async function loader({ params, context }: Route.LoaderArgs) {
  const id = (params.id ?? '').replace(/\.json$/, '');
  const record = await getContract(getDb(context.cloudflare.env), contractIdFromSlug(id));
  if (!record) return withDataSource(Response.json({ error: 'not_found' }, { status: 404 }));
  const masked = maskContractForPrivacy(record, record.bidder_legal_form);
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': publicCache(3600),
  });
  if (masked !== record) headers.set('X-Robots-Tag', 'noindex');
  return withDataSource(new Response(serializeJsonForScript(masked), { headers }));
}
