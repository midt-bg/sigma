import { createHash } from 'node:crypto';

// ControlHash is a short source checksum and sometimes even an error message.
// Only byte-identical XML is a safe automatic republication duplicate. A changed
// document is retained for review, even when its supplied checksum is unchanged.
export const documentFingerprint = (xml) => createHash('sha256').update(xml).digest('hex');

export { personNameKey as declarantNameKey } from '../../packages/shared/src/person-identity.ts';
import { personNameKey as declarantNameKey } from '../../packages/shared/src/person-identity.ts';

// Punctuation and spacing are presentation differences. Missing/reordered name
// components, spelling changes and multiple listed people need source review.
export function declarationAttribution(declarant, listedNames) {
  const name = declarantNameKey(declarant);
  if (!name) return 'missing_declarant';
  const listed = new Set(listedNames.map(declarantNameKey).filter(Boolean));
  if (!listed.size) return 'unlisted_document';
  if (listed.size !== 1) return 'ambiguous_listing';
  if (!listed.has(name)) return 'declarant_mismatch';
  return 'matched';
}
