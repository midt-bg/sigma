import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTACT_EMAIL } from './contact';

// RFC 9116: served as a static asset (wrangler uploads `.well-known`). An expired file tells researchers the
// contact is stale — renew Expires (at most a year ahead) when this fails.
describe('/.well-known/security.txt', () => {
  const text = readFileSync(
    new URL('../../public/.well-known/security.txt', import.meta.url),
    'utf8',
  );

  it('names the site’s public contact and an Expires still in the future', () => {
    expect(text).toContain(`Contact: mailto:${CONTACT_EMAIL}\n`);
    const expires = Date.parse(text.match(/^Expires: (.+)$/m)?.[1] ?? '');
    expect(expires).toBeGreaterThan(Date.now());
  });
});
