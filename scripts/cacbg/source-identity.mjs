import { createHash } from 'node:crypto';

// ControlHash is a short source checksum and sometimes even an error message.
// Only byte-identical XML is a safe automatic republication duplicate. A changed
// document is retained for review, even when its supplied checksum is unchanged.
export const documentFingerprint = (xml) => createHash('sha256').update(xml).digest('hex');

export { personNameKey as declarantNameKey } from '../../packages/shared/src/person-identity.ts';
import {
  personNameKey as declarantNameKey,
  personNamesAlike,
  withoutPersonTitle,
} from '../../packages/shared/src/person-identity.ts';

// Punctuation and spacing are presentation differences. Missing/reordered name
// components and multiple listed people need source review.
//
// The listing and the document are two spellings of ONE record's subject, written by the same
// registry, and the declarant's identity comes from the document's own identifier (ADR-0042) — this
// check only guards against a file announced under someone else. Requiring the two spellings to be
// byte-equal therefore threw away declarations over the register's own slips: a title („д-р"), one
// mistyped letter („Васасилев"), a surname taken on marriage, an added or dropped second surname.
// Measured on the 2026 set: 457 of 17,709 documents (2.6%), among them ministers and MPs. So a
// second chance with `personNamesAlike` — given and father's name equal or one typo apart, and a
// shared surname — which is the same comparison the registry layer already trusts for identity.
// It is reported as its own attribution, never silently as an exact match, so the rate stays visible.
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
  return personNamesAlike(named, listedName) ? 'name_variant' : 'declarant_mismatch';
}
