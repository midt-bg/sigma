import { createHash } from 'node:crypto';

// ControlHash is a short source checksum and sometimes even an error message.
// Only byte-identical XML is a safe automatic republication duplicate. A changed
// document is retained for review, even when its supplied checksum is unchanged.
export const documentFingerprint = (xml) => createHash('sha256').update(xml).digest('hex');

export { personNameKey as declarantNameKey } from '../../packages/shared/src/person-identity.ts';
import {
  personNameKey as declarantNameKey,
  oneSlipApart,
  withoutPersonTitle,
} from '../../packages/shared/src/person-identity.ts';

// Punctuation and spacing are presentation differences. Missing/reordered name
// components and multiple listed people need source review.
//
// The listing and the document are two spellings of ONE record's subject, written by the same registry,
// and the declarant's identity comes from the document's own identifier (ADR-0042) — this check only
// guards against a file announced under someone else. Requiring the two spellings to be byte-equal
// therefore threw away declarations over the registry's own slips: a title („д-р") or one mistyped
// letter („Герогиев" for „Георгиев", „Ллаов" for „Лалов"). Measured on the 2026 set: 457 of 17,709
// documents (2.6%), among them ministers and MPs.
//
// A SLIP is accepted — same components in the same order, exactly one of them a single edit or a swap
// of two adjacent letters apart. A NAME CHANGE is not: a dropped or added surname, or a surname taken
// on marriage, stays a mismatch here, because only the Trade Register can establish that two names are
// one person (ADR-0033) and `registryIdentityResolver` already answers `registry_alias` when it can
// prove it. Accepted slips are reported as their own attribution, never as an exact match, so the rate
// stays visible.
/** Same components in the same order, exactly one of them a single slip apart. */
function oneSlipName(a, b) {
  const x = declarantNameKey(a).split(' ').filter(Boolean);
  const y = declarantNameKey(b).split(' ').filter(Boolean);
  if (x.length < 3 || x.length !== y.length) return false;
  let slips = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    if (++slips > 1 || !oneSlipApart(x[i], y[i])) return false;
  }
  return slips === 1;
}
export function declarationAttribution(declarant, listedNames) {
  const name = declarantNameKey(declarant);
  if (!name) return 'missing_declarant';
  const listed = new Set(listedNames.map(declarantNameKey).filter(Boolean));
  if (!listed.size) return 'unlisted_document';
  if (listed.size !== 1) return 'ambiguous_listing';
  // A title is presentation on one side only, so it is stripped before the exact comparison and a
  // „д-р" never counts as a variant.
  const named = withoutPersonTitle(declarant);
  const announced = listedNames.find((n) => declarantNameKey(n)) ?? '';
  const listedName = withoutPersonTitle(announced);
  if (listed.has(name) || declarantNameKey(named) === declarantNameKey(listedName))
    return 'matched';
  return oneSlipName(named, listedName) ? 'name_variant' : 'declarant_mismatch';
}
