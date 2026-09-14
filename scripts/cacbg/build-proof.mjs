import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
export async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function recordBuild(db, staging) {
  const manifest = JSON.parse(readFileSync(`${staging}/manifest.json`, 'utf8'));
  writeFileSync(
    `${db}.build.json`,
    JSON.stringify({
      complete: manifest.corpusComplete === true,
      extractedAt: manifest.extractedAt,
    }),
  );
}
export async function assertAuditedBuild(db) {
  const proof = JSON.parse(readFileSync(`${db}.audited.json`, 'utf8'));
  if (proof.complete !== true || proof.sha256 !== (await fileDigest(db)))
    throw new Error('refusing to ship: work DB is not the audited, completed build');
}
