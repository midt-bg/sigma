// describe_schema — the curated data dictionary the model reads before writing any SQL.
//
// Per spec §9 point 2 this is the highest-leverage prompt asset: a weak 27B writes correct SQL only
// if the dictionary spells out the non-obvious traps it cannot guess. Getting `SUM(amount)` instead
// of `SUM(amount_eur)` returns a garbage total attributed to АОП — defamation/disinfo by accident.
// Grounded in packages/db/migrations/0000_init.sql; keep in sync when the schema changes.

// Imperative rules — stated as MUST/NEVER so the model treats them as hard constraints, not hints.
export const DATA_TRAPS: string[] = [
  'Парични агрегати: СУМИРАЙ САМО `contracts.amount_eur` (каноничен EUR, безопасен за сумиране). ' +
    'НИКОГА не сумирай `contracts.amount` — то е „както е записано" в смесена валута (`currency`), само за показване.',
  'Сумите по подразбиране пропускат редове с `amount_eur IS NULL` — това са редове БЕЗ надеждна EUR ' +
    'стойност (чужда валута без курс, `value_suspect` без оценка, или липсва подписана/текуща стойност). ' +
    '`amount_eur IS NULL` НЕ Е синоним на `value_suspect`: `value_suspect` редове с оценка СА поправени до ' +
    'оценката на процедурата и се включват в сумите. Брой „непотвърдени" = редове с ' +
    "`value_flag = 'value_suspect'` (НЕ редове с NULL `amount_eur`; готовото число е `home_totals.suspect`).",
  '`value_flag` ∈ {ok, review, value_low, value_suspect, annex_suspect} мени значението на стойността на ' +
    'реда; `date_flag` ∈ {ok, signed_after_publication} е вердикт за датата, не за стойността.',
  "`tenders.procedure_type = 'неизвестна'` маркира СИНТЕТИЧНИ (само-договорни) преписки — " +
    'изключи ги при анализ на разпределението по процедура, освен ако нарочно ги искаш.',
  '`lots` са на grain по обособена позиция — не ги брой едно към едно срещу `contracts`.',
  '`parties.ocid` НЕ Е УНП и никога не се join-ва като равно на УНП. УНП (`uniqueProcurementNumber`) ' +
    'свързва `tenders`/`contracts`.',
  'За класации/тотали предпочитай готовите rollup таблици (`authority_totals.spent_eur`, ' +
    '`company_totals.won_eur`) — те съвпадат с водещите числа на самия сайт.',
  'Свежест и обхват на данните идват от `data_freshness`; всяка справка цитира свежест по източник.',
  'В `JOIN … ON` ВИНАГИ квалифицирай колоните с псевдоним на таблицата (`a.id = b.id`) и свържи двете ' +
    'страни — константно или едностранно условие (`ON 1=1`) се отхвърля като декартово произведение.',
  '`run_sql` НЕ поддържа FTS `MATCH` (заявката се отхвърля от парсера) — за неточно/свободно търсене ' +
    'по име ползвай `semantic_search`, после join-вай по върнатия id; за класации ползвай rollup-ите.',
];

export interface TableDoc {
  name: string;
  grain: string;
  columns: string; // compact "col (note)" list — full DDL lives in the migration
}

export const TABLES: TableDoc[] = [
  {
    name: 'authorities',
    grain: 'един възложител',
    columns: 'id, name, type_group, settlement, region, bulstat',
  },
  {
    name: 'tenders',
    grain: 'една преписка/процедура',
    columns:
      "id, source_id (УНП), authority_id→authorities, cpv_code, cpv_description, procedure_type ('неизвестна'=синтетична)",
  },
  {
    name: 'lots',
    grain: 'обособена позиция',
    columns: 'id, tender_id→tenders, cpv_code, value_amount',
  },
  {
    name: 'bidders',
    grain: 'един изпълнител',
    columns: "id, name, kind ('company'|'consortium'), eik_normalized, eik_valid",
  },
  {
    name: 'contracts',
    grain: 'един възложен договор (на ниво лот)',
    columns:
      'id, tender_id→tenders, bidder_id→bidders, amount (display, в `currency`), currency, ' +
      'amount_eur (КАНОНИЧЕН EUR, SAFE TO SUM; NULL=няма надеждна EUR стойност), value_flag, date_flag, ' +
      'fx_converted, fx_rate, signed_at, bids_received, eu_funded',
  },
  {
    name: 'amendments',
    grain: 'един анекс',
    columns:
      'id, natural_key, unp (=УНП, свързва tenders/contracts), contract_number, ' +
      'value_before, value_after, value_delta, currency, published_at',
  },
  {
    name: 'parties',
    grain: 'една страна по OCDS преписка',
    columns: 'party_key, eik, ocid (≠ УНП!), party_id, name, region_nuts',
  },
  {
    name: 'authority_totals',
    grain: 'rollup на възложител',
    columns:
      'authority_id, name, region (NUTS3; NULL=неразпределени), spent_eur, contracts, suppliers, …',
  },
  {
    name: 'company_totals',
    grain: 'rollup на изпълнител',
    columns: 'bidder_id, won_eur, contracts, authorities, …',
  },
  {
    name: 'sector_totals',
    grain: 'rollup по CPV раздел',
    columns: 'division, value_eur, contracts',
  },
  {
    name: 'home_totals',
    grain: 'единичен ред — глобални суми',
    columns: 'contracts, value_eur, authorities, bidders, suspect, as_of',
  },
  {
    name: 'facet_counts',
    grain: 'брой за филтър-фасет',
    columns: "facet ('year'|'procedure'|'eu'), key, contracts",
  },
  {
    name: 'flow_pairs',
    grain: 'поток възложител→изпълнител',
    columns:
      'authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts',
  },
  {
    name: 'search_index',
    grain: 'FTS5 индекс',
    columns:
      "kind ('authority'|'company'|'contract'), ref, title, ident, subtitle, amount UNINDEXED",
  },
  {
    name: 'data_freshness',
    grain: 'таблица — свежест/обхват',
    columns: 'source, as_of, refreshed_at',
  },
];

// Canonical example queries — the model adapts these rather than inventing joins from scratch.
export const CANONICAL_QUERIES: { intent: string; sql: string }[] = [
  {
    intent: 'Най-големи възложители по похарчено',
    sql: 'SELECT a.name, a.id AS authority_id, t.spent_eur\nFROM authority_totals t JOIN authorities a ON a.id = t.authority_id\nORDER BY t.spent_eur DESC LIMIT 20;',
  },
  {
    intent: 'Най-големи изпълнители по спечелено',
    sql: 'SELECT b.name, b.id AS bidder_id, t.won_eur\nFROM company_totals t JOIN bidders b ON b.id = t.bidder_id\nORDER BY t.won_eur DESC LIMIT 20;',
  },
  {
    intent: 'Разход по година (timeseries) — само чисти EUR редове',
    sql: 'SELECT substr(c.signed_at, 1, 4) AS year, SUM(c.amount_eur) AS total_eur\nFROM contracts c\nWHERE c.amount_eur IS NOT NULL AND c.signed_at IS NOT NULL\nGROUP BY year ORDER BY year;',
  },
  {
    intent: 'Дял на договорите с една оферта',
    sql: 'SELECT\n  SUM(CASE WHEN c.bids_received = 1 THEN c.amount_eur ELSE 0 END) AS single_offer_eur,\n  SUM(c.amount_eur) AS total_eur\nFROM contracts c WHERE c.amount_eur IS NOT NULL;',
  },
  {
    intent: 'Разход по CPV сектор',
    sql: 'SELECT s.division, s.value_eur, s.contracts\nFROM sector_totals s ORDER BY s.value_eur DESC LIMIT 20;',
  },
  {
    intent: 'Възложители с най-висок дял договори с една оферта (сигнал за слаба конкуренция)',
    sql: 'SELECT a.name, t.authority_id AS authority_id, COUNT(*) AS contracts,\n  SUM(CASE WHEN c.bids_received = 1 THEN 1 ELSE 0 END) AS single_offer,\n  SUM(CASE WHEN c.bids_received = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS single_offer_share\nFROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id\nWHERE c.bids_received >= 1\nGROUP BY t.authority_id HAVING COUNT(*) >= 20\nORDER BY single_offer_share DESC, contracts DESC LIMIT 20;',
  },
  {
    intent:
      'Концентрация на доставчици при възложител (HHI — близо до 1 = малко доставчици взимат всичко)',
    sql: 'WITH pair AS (\n  SELECT t.authority_id AS authority_id, c.bidder_id AS bidder_id, SUM(c.amount_eur) AS spent\n  FROM contracts c JOIN tenders t ON t.id = c.tender_id\n  WHERE c.amount_eur IS NOT NULL\n  GROUP BY t.authority_id, c.bidder_id\n), tot AS (\n  SELECT authority_id, SUM(spent) AS total, COUNT(*) AS suppliers FROM pair GROUP BY authority_id\n)\nSELECT a.name, p.authority_id AS authority_id, tot.suppliers AS suppliers,\n  SUM((p.spent / tot.total) * (p.spent / tot.total)) AS hhi\nFROM pair p JOIN tot ON tot.authority_id = p.authority_id JOIN authorities a ON a.id = p.authority_id\nWHERE tot.suppliers >= 2\nGROUP BY p.authority_id ORDER BY hhi DESC LIMIT 20;',
  },
  {
    intent: 'Разход по месеци (timeseries) — само валидно датирани, чисти EUR редове',
    sql: "SELECT substr(c.signed_at, 1, 7) AS period, SUM(c.amount_eur) AS total_eur, COUNT(*) AS contracts\nFROM contracts c\nWHERE c.amount_eur IS NOT NULL AND substr(c.signed_at, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'\n  AND c.signed_at >= '2020-01-01' AND c.signed_at <= date('now')\nGROUP BY period ORDER BY period;",
  },
  {
    intent: 'Разход по област (NUTS3) — от rollup-а; празно region = неразпределени',
    sql: 'SELECT region, SUM(spent_eur) AS value_eur, SUM(contracts) AS contracts\nFROM authority_totals GROUP BY region ORDER BY value_eur DESC;',
  },
  {
    intent:
      'Най-големи потоци възложител→изпълнител (ребрата на графа на връзките; за един субект добави WHERE authority_id = … или bidder_id = …)',
    sql: 'SELECT authority_name, bidder_name, won_eur, contracts\nFROM flow_pairs ORDER BY won_eur DESC LIMIT 20;',
  },
];

// Render DATA_TRAPS as a numbered list. Shared by describeSchema (full dictionary) and the RAG
// hard-traps block (system-prompt.ts) so both paths render the traps identically and cannot drift.
export function renderTraps(): string {
  return DATA_TRAPS.map((t, i) => `${i + 1}. ${t}`).join('\n');
}

/** Build the schema prompt asset the agent reads before writing SQL (returned by the tool). */
export function describeSchema(): string {
  const tables = TABLES.map((t) => `- ${t.name} — grain: ${t.grain}\n    ${t.columns}`).join('\n');
  const queries = CANONICAL_QUERIES.map((q) => `-- ${q.intent}\n${q.sql}`).join('\n\n');
  return [
    '# Речник на данните (чети преди да пишеш SQL)',
    '\n## Задължителни правила за данните (капани — важат за всеки въпрос)\n' + renderTraps(),
    '\n## Таблици\n' + tables,
    '\n## Канонични примерни заявки\n' + queries,
  ].join('\n');
}
