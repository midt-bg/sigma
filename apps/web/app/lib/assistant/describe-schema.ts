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
  '`amount_eur IS NULL` само когато няма надежден EUR еквивалент: (1) `value_flag = value_suspect` ' +
    'БЕЗ оценка на процедурата; (2) чуждестранна валута БЕЗ ECB обменен курс за датата на подписване; ' +
    '(3) липсват и `signing_value`, и `current_value`. ' +
    '`value_suspect` редове С оценка се ПОПРАВЯТ и НЕ са NULL — имат `amount_eur` и влизат в сумите. ' +
    'Сумите по подразбиране изключват NULL; брой на „без стойност" = `COUNT(*) WHERE amount_eur IS NULL`.',
  '`value_flag` ∈ {ok, review, value_low, annex_suspect, value_suspect} мени значението на стойността на реда; ' +
    '`date_flag` ∈ {ok, signed_after_publication} е вердикт за датата, не за стойността.',
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
  'За да намериш организация (възложител/изпълнител) по ИМЕ, ПОЛЗВАЙ `find_entity` — той е нечувствителен ' +
    'към регистъра (главни/малки) и диакритиката и връща точното id. НЕ търси име с `LIKE`/`=` върху ' +
    '`name`: за кирилица SQLite сравнява чувствително към регистъра, а имената често се пазят с ГЛАВНИ ' +
    "букви (напр. „СТОЛИЧНА ОБЩИНА\"), затова `LIKE '%Столична община%'` връща 0 реда и грешно изглежда " +
    'като „няма такъв субект". Взетото id ползвай в run_sql (`t.authority_id = <id>` / `c.bidder_id = <id>`). ' +
    '`run_sql` НЕ поддържа FTS `MATCH` (парсерът я отхвърля); за парафрази/синоними допълва `semantic_search`.',
  'Всяка заявка към базовата `contracts` ЗАДЪЛЖИТЕЛНО носи `amount_eur IS NOT NULL` И изключване на ' +
    'синтетичните записи (`c.is_synthetic != 1`) като условия на най-горното WHERE — иначе ' +
    'се отхвърля. Затова обикновените броеве са вече ФИЛТРИРАНИ броеве. Въпрос като „колко договора нямат ' +
    'записана стойност" НЕ се отговаря с `COUNT(*)` върху `contracts` (ще бъде отхвърлен); ползвай ' +
    'корпусните броеве (`home_totals.contracts` брои ВСИЧКИ договори, вкл. NULL `amount_eur`) или го посочи ' +
    'като ограничение в справката.',
  '`amendments` НЕ съдържа колона `contract_id`. Join-ва се по `unp` и `contract_number`: ' +
    '`LEFT JOIN amendments a ON a.unp = t.source_id AND a.contract_number = c.contract_number` ' +
    '(изисква `JOIN tenders t` в заявката). За бърза справка „има ли анекси" ползвай ' +
    '`contracts.annex_count > 0` без JOIN; `contracts.current_value_eur` дава EUR стойността след последния анекс.',
  'УНП на договор е `tenders.source_id` — достъпва се през `JOIN tenders t ON t.id = c.tender_id`. ' +
    "За да намериш всички договори по дадено УНП: `WHERE t.source_id = '00123-2024-0001'` (замени с реалния УНП).",
  'Времеви серии (разход/брой по ГОДИНА или МЕСЕЦ — `substr(c.signed_at,1,4|7)` в SELECT/GROUP BY) ' +
    "ЗАДЪЛЖИТЕЛНО ограничавай обхвата: `c.signed_at >= '2020-01-01' AND c.signed_at <= date('now')` " +
    "(или фиксирай период, напр. `substr(c.signed_at,1,4) = '2024'`) — иначе се отхвърля. Причината: " +
    'има редове с дефектна дата извън покритието (напр. 2016, 2029), които иначе образуват фалшиви ' +
    'кофи-години. Покритието е 2020–2026; НЕ цитирай в текста години извън наличните данни.',
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
      'id, source_id (УНП), authority_id→authorities, cpv_code, cpv_description, ' +
      "procedure_type (пълна таксономия — 'неизвестна'=синтетична), estimated_value, " +
      "status ('awarded'|'published'), " +
      'eop_tender_id (числов id за deep link: https://app.eop.bg/today/<eop_tender_id>), ' +
      'green, social, innovation (1=да, NULL=не — policy flags)',
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
      'id, tender_id→tenders, bidder_id→bidders, contract_number, amount (display, в `currency`), currency, ' +
      'amount_eur (КАНОНИЧЕН EUR, SAFE TO SUM; NULL=suspect/FX), value_flag, date_flag, ' +
      'signed_at, bids_received, eu_funded, ' +
      'is_synthetic (1=синтетична преписка=procedure_type неизвестна, 0=нормална; филтрирай с c.is_synthetic != 1), ' +
      'annex_count (брой анекси; 0=няма), current_value_eur (EUR след последния анекс), ' +
      'signing_value_eur (EUR при сключване — за анализ на отклонение след анекси), ' +
      "contract_kind (Доставки/Услуги/Строителство), winner_size ('micro'|'small'|'medium'|'large'), " +
      'eu_programme (EU фонд/програма), duration_days, framework (1=по рамково споразумение), ' +
      'bids_rejected, bids_sme',
  },
  {
    name: 'amendments',
    grain: 'един анекс към договор',
    columns:
      'id, unp (=tenders.source_id — join ключ към преписката), ' +
      'contract_number (=contracts.contract_number — join ключ към договора), ' +
      'value_before, value_after, value_delta (стойностна промяна от анекса), currency, published_at, description',
  },
  { name: 'parties', grain: 'роля по OCDS преписка', columns: 'ocid (≠ УНП!), role, …' },
  {
    name: 'authority_totals',
    grain: 'rollup на възложител',
    columns:
      'authority_id, name, type_group, region (NUTS3 код; NULL=неразпределени — JOIN nuts_regions ON nuts_regions.nuts3 = region), spent_eur, contracts, suppliers, avg_eur, eu_eur, first_date, last_date',
  },
  {
    name: 'company_totals',
    grain: 'rollup на изпълнител',
    columns:
      'bidder_id, name, kind, eik, won_eur, contracts, authorities, eu_eur, primary_sector, first_date, last_date',
  },
  {
    name: 'sector_totals',
    grain: 'rollup по CPV раздел',
    columns: 'division, value_eur, contracts',
  },
  {
    name: 'home_totals',
    grain: 'единичен ред — глобални суми',
    columns:
      'contracts (COUNT(*) ВСИЧКИ редове, вкл. NULL amount_eur), ' +
      'value_eur (SUM(amount_eur) само чисти редове — РАЗЛИЧЕН знаменател от contracts!), ' +
      'authorities, bidders, suspect (брой value_suspect), as_of',
  },
  {
    name: 'facet_counts',
    grain: 'брой за филтър-фасет',
    columns: "facet ('year'|'procedure'|'eu'), key, contracts, value_eur",
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
    grain: 'view — свежест/обхват',
    columns: 'source, as_of, refreshed_at',
  },
  {
    name: 'nuts_regions',
    grain: 'NUTS3 регион (28 области)',
    columns:
      "nuts3 (PK, напр. 'BG411'), nuts3_name (напр. 'София (столица)'), " +
      "nuts2, nuts2_name (напр. 'Югозападен'), nuts1, nuts1_name — " +
      'join с authority_totals: `JOIN nuts_regions n ON n.nuts3 = at.region`',
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
    intent: 'Разход по година (timeseries) — само валидно датирани, чисти EUR редове',
    sql: "SELECT substr(c.signed_at, 1, 4) AS year, SUM(c.amount_eur) AS total_eur\nFROM contracts c\nWHERE c.amount_eur IS NOT NULL AND c.is_synthetic != 1\n  AND substr(c.signed_at, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'\n  AND c.signed_at >= '2020-01-01' AND c.signed_at <= date('now')\nGROUP BY year ORDER BY year;",
  },
  {
    intent:
      'Дял на договорите с една оферта (по стойност) — включи и готовия дял (0..1), не само сумите',
    sql: 'SELECT\n  SUM(CASE WHEN c.bids_received = 1 THEN c.amount_eur ELSE 0 END) AS single_offer_eur,\n  SUM(c.amount_eur) AS total_eur,\n  SUM(CASE WHEN c.bids_received = 1 THEN c.amount_eur ELSE 0 END) * 1.0 / SUM(c.amount_eur) AS single_offer_share\nFROM contracts c\nWHERE c.amount_eur IS NOT NULL AND c.is_synthetic != 1;',
  },
  {
    intent: 'Разход по CPV сектор',
    sql: 'SELECT s.division, s.value_eur, s.contracts\nFROM sector_totals s ORDER BY s.value_eur DESC LIMIT 20;',
  },
  {
    intent: 'Възложители с най-висок дял договори с една оферта (сигнал за слаба конкуренция)',
    sql: 'SELECT a.name, t.authority_id AS authority_id, COUNT(*) AS contracts,\n  SUM(CASE WHEN c.bids_received = 1 THEN 1 ELSE 0 END) AS single_offer,\n  SUM(CASE WHEN c.bids_received = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS single_offer_share\nFROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id\nWHERE c.amount_eur IS NOT NULL AND c.is_synthetic != 1 AND c.bids_received >= 1\nGROUP BY t.authority_id HAVING COUNT(*) >= 20\nORDER BY single_offer_share DESC, contracts DESC LIMIT 20;',
  },
  {
    intent:
      'Концентрация на доставчици при възложител (HHI — близо до 1 = малко доставчици взимат всичко)',
    sql: 'WITH pair AS (\n  SELECT t.authority_id AS authority_id, c.bidder_id AS bidder_id, SUM(c.amount_eur) AS spent\n  FROM contracts c JOIN tenders t ON t.id = c.tender_id\n  WHERE c.amount_eur IS NOT NULL AND c.is_synthetic != 1\n  GROUP BY t.authority_id, c.bidder_id\n), tot AS (\n  SELECT authority_id, SUM(spent) AS total, COUNT(*) AS suppliers FROM pair GROUP BY authority_id\n)\nSELECT a.name, p.authority_id AS authority_id, tot.suppliers AS suppliers,\n  SUM((p.spent / tot.total) * (p.spent / tot.total)) AS hhi\nFROM pair p JOIN tot ON tot.authority_id = p.authority_id JOIN authorities a ON a.id = p.authority_id\nWHERE tot.suppliers >= 2\nGROUP BY p.authority_id ORDER BY hhi DESC LIMIT 20;',
  },
  {
    intent: 'Разход по месеци (timeseries) — само валидно датирани, чисти EUR редове',
    sql: "SELECT substr(c.signed_at, 1, 7) AS period, SUM(c.amount_eur) AS total_eur, COUNT(*) AS contracts\nFROM contracts c\nWHERE c.amount_eur IS NOT NULL AND c.is_synthetic != 1\n  AND substr(c.signed_at, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'\n  AND c.signed_at >= '2020-01-01' AND c.signed_at <= date('now')\nGROUP BY period ORDER BY period;",
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
  {
    intent:
      'Договори по УНП — намери всички договори от конкретна преписка ' +
      '(задължителният филтър изключва редове без EUR стойност и синтетични преписки; ' +
      'за пълен списък с анекси ползвай contracts.annex_count и current_value_eur)',
    sql: "SELECT c.id, c.contract_number, c.amount_eur, c.signed_at, b.name AS bidder_name\nFROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN bidders b ON b.id = c.bidder_id\nWHERE t.source_id = '00123-2024-0001' AND c.amount_eur IS NOT NULL AND c.is_synthetic != 1;",
  },
  {
    intent: 'Анекси към преписка — история на стойностните промени (join по unp=tenders.source_id)',
    sql: "SELECT a.contract_number, a.value_before, a.value_after, a.value_delta, a.currency, a.published_at, a.description\nFROM amendments a\nWHERE a.unp = '00123-2024-0001'\nORDER BY a.published_at;",
  },
  {
    intent:
      'Разход по NUTS2 макрорегион — агрегат от rollup-а на възложители ' +
      '(LEFT JOIN включва и възложители без NUTS3 регион — те падат в „Неразпределени")',
    sql: "SELECT COALESCE(n.nuts2_name, 'Неразпределени') AS macro_region, SUM(at.spent_eur) AS spent_eur, SUM(at.contracts) AS contracts\nFROM authority_totals at LEFT JOIN nuts_regions n ON n.nuts3 = at.region\nGROUP BY macro_region ORDER BY spent_eur DESC;",
  },
];

/** Build the schema prompt asset the agent reads before writing SQL (returned by the tool). */
export function describeSchema(): string {
  const traps = DATA_TRAPS.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const tables = TABLES.map((t) => `- ${t.name} — grain: ${t.grain}\n    ${t.columns}`).join('\n');
  const queries = CANONICAL_QUERIES.map((q) => `-- ${q.intent}\n${q.sql}`).join('\n\n');
  return [
    '# Речник на данните (чети преди да пишеш SQL)',
    '\n## Задължителни правила (капани в данните)\n' + traps,
    '\n## Таблици\n' + tables,
    '\n## Канонични примерни заявки\n' + queries,
  ].join('\n');
}
