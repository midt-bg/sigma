// The nodes of a tie graph (company-ties.ts, registry.ts): a company, sized by what it won, and a person the
// Trade Register records, who wins nothing and is not sized by money.
import type { CompanyTieNode } from '@sigma/api-contract';
import { cleanName, entityName } from '@sigma/shared';
import { companySlug, registryPersonSlug } from './identity';

export function companyNode(
  id: string,
  name: string,
  kind: 'company' | 'consortium',
  wonEur: number | null,
  conflicts: number,
  hop: number,
): CompanyTieNode {
  const slug = companySlug(id);
  return {
    id,
    kind: 'company',
    label: entityName(cleanName(name), kind),
    slug,
    valueEur: wonEur ?? 0,
    hop,
    // Only offered when the company actually has a published link — the declared-people section exists
    // on its page only then.
    conflictsHref: conflicts > 0 ? `/companies/${slug}#declared-people` : null,
  };
}

/** The node id of a person the register identifies — a namespace of its own, apart from declared officials. */
export const personNodeId = (indent: string): string => `rp:${indent}`;

export function personNode(indent: string, name: string, hop: number): CompanyTieNode {
  return {
    id: personNodeId(indent),
    kind: 'person',
    label: name,
    slug: registryPersonSlug(indent),
    valueEur: 0,
    hop,
    conflictsHref: null,
  };
}
