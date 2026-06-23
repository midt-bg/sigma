import { data } from 'react-router';
import { search } from '@sigma/db';
import type { SearchGroup, SearchResults } from '@sigma/api-contract';
import type { Route } from './+types/search.suggest';
import { publicCache } from '../lib/cache';

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
export async function loader({ request, context }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams.get('q') ?? '';
  const results = await search(context.cloudflare.env.DB, q);
  const payload: SearchResults = { ...results, groups: results.groups.map(trimGroup) };
  return data(payload, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Short edge cache: queries repeat heavily as people type the same prefixes.
      'Cache-Control': publicCache(120),
    },
  });
}
