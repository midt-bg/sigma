import { authorityIdFromSlug, bidderIdFromSlug, type NetworkParams } from '@sigma/db';
import type { NetworkData } from '@sigma/api-contract';

// The /network `?center` grammar — `a:<authority-slug>` | `c:<company-slug>` — lives here once so the
// link/re-centre side (centerToken) and the loader side (parseCenter) share a single definition and
// can never drift apart (a drift would break re-centring silently). See routes/network.tsx (loader)
// and components/NetworkGraph.tsx (re-centre).

export function centerToken(n: { kind: string; slug: string }): string {
  return `${n.kind === 'authority' ? 'a' : 'c'}:${n.slug}`;
}

export function parseCenter(token: string | null): NetworkParams | null {
  if (!token) return null;
  const i = token.indexOf(':');
  if (i < 1) return null;
  const kind = token.slice(0, i);
  const slug = token.slice(i + 1);
  if (kind === 'a' && slug) return { kind: 'authority', id: authorityIdFromSlug(slug) };
  if (kind === 'c' && slug) {
    const id = bidderIdFromSlug(slug);
    return id ? { kind: 'company', id } : null;
  }
  return null;
}

// A re-centre fetch result is adoptable only if it is a real, non-trivial ego-network (has a centre
// and ≥2 nodes). Otherwise NetworkGraph's render guard would strip the whole component mid-session,
// stranding the user with no way back. Pure so it can be unit-tested.
export function isAdoptableNetwork(next: NetworkData | null | undefined): boolean {
  return Boolean(next?.center && next.nodes.length >= 2);
}
