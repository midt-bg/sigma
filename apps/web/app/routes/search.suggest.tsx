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
  const url = new URL(request.url);
  const q = url.searchParams.get('q') ?? '';
  // Single-mount machine route (no `/en` path prefix), so the active locale arrives as an explicit
  // `?locale=` param from the client — otherwise consortium names default to the Bulgarian „… и др."
  // suffix even on /en.
  const locale = url.searchParams.get('locale') === 'en' ? 'en' : 'bg';
  const results = await search(context.cloudflare.env.DB, q, locale);
  const payload: SearchResults = { ...results, groups: results.groups.map(trimGroup) };
  return data(payload, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Short edge cache: queries repeat heavily as people type the same prefixes.
      'Cache-Control': publicCache(120),
    },
  });
}
