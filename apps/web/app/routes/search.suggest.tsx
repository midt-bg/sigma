import { data } from 'react-router';
import { search, getDb } from '@sigma/db';
import type { SearchGroup, SearchResults } from '@sigma/api-contract';
import type { Route } from './+types/search.suggest';
import { publicCache } from '../lib/cache';
import { isD1Refusal } from '../lib/retry';

// Names the answer given without the database, as the footer's degraded pages do (workers/edge-entry.ts).
// The search box reads it as a refusal: no list, rather than „no matches" for text that may well match.
export const SUGGEST_DEGRADED = 'suggest';

// How many hits per kind a suggestion dropdown shows. The full `/search` page keeps the wider set;
// the typeahead stays compact so the listbox never dwarfs the field that opened it.
const SUGGEST_PER_GROUP = 4;

export function trimGroup(group: SearchGroup): SearchGroup {
  if (group.hits.length <= SUGGEST_PER_GROUP) return group;
  return { ...group, hits: group.hits.slice(0, SUGGEST_PER_GROUP) };
}

// Resource route powering the live search combobox (/search/suggest?q=…). Reuses the same ranked
// FTS query as the full results page, so suggestions and the eventual page agree. JSON only — the
// listbox is rendered client-side from this payload; with JS off the form still posts to /search.
//
// When D1 refuses the read (overloaded), the box gets an empty list instead of a 503 page: suggestions are
// worth nothing a second later, so the answer is never stored (`no-store`) and the next pause asks again.
// Any other failure still fails the request.
export async function loader({ request, context }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams.get('q') ?? '';
  let results: SearchResults;
  try {
    results = await search(getDb(context.cloudflare.env), q);
  } catch (error) {
    if (!isD1Refusal(error)) throw error;
    const empty: SearchResults = { query: q.trim(), groups: [], empty: true };
    return data(empty, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Sigma-Degraded': SUGGEST_DEGRADED,
      },
    });
  }
  const payload: SearchResults = { ...results, groups: results.groups.map(trimGroup) };
  return data(payload, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Short edge cache: queries repeat heavily as people type the same prefixes.
      'Cache-Control': publicCache(120),
    },
  });
}
