import {
  authorityIdFromSlug,
  bidderIdFromSlug,
  isValidEikSlug,
  type NetworkParams,
} from '@sigma/db';
import type { NetworkData, NetworkEdge } from '@sigma/api-contract';

// The /network `?center` grammar — `a:<authority-slug>` | `c:<company-slug>` — lives here once so the
// link/re-centre side (centerToken) and the loader side (parseCenter) share a single definition and
// can never drift apart (a drift would break re-centring silently). See routes/network.tsx (loader)
// and components/NetworkGraph.tsx (re-centre).

export function centerToken(n: { kind: 'authority' | 'company'; slug: string }): string {
  let prefix: 'a' | 'c';
  switch (n.kind) {
    case 'authority':
      prefix = 'a';
      break;
    case 'company':
      prefix = 'c';
      break;
    default:
      throw new Error(`centerToken: unknown node kind ${JSON.stringify(n.kind)}`);
  }
  return `${prefix}:${encodeURIComponent(n.slug)}`;
}

export function parseCenter(token: string | null): NetworkParams | null {
  if (!token) return null;
  const i = token.indexOf(':');
  if (i < 1) return null;
  const kind = token.slice(0, i);
  let slug: string;
  try {
    slug = decodeURIComponent(token.slice(i + 1));
  } catch {
    // Malformed %-escape (e.g. a hand-edited/bookmarked URL) — fall back to "no centre" like any
    // other malformed token, matching the `?center` grammar's documented invariant.
    return null;
  }
  if (kind === 'a' && slug) {
    return isValidEikSlug(slug) ? { kind: 'authority', id: authorityIdFromSlug(slug) } : null;
  }
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

// Edge orientation in the graph topology is arbitrary — a direct edge may point either
// centre→neighbour or neighbour→centre (e.g. authority→company). Count both ends so a centre with
// only inbound edges doesn't read as having zero direct counterparties. Shared by NetworkGraph (the
// "N of M" truncation hint) and the /network route (the relations-table hint) so they can't diverge.
export function countDirectEdges(
  edges: NetworkEdge[],
  centerId: string | null | undefined,
): number {
  if (!centerId) return 0;
  return edges.filter((e) => e.from === centerId || e.to === centerId).length;
}
