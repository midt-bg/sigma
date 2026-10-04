// Public ownership as the Trade Register records it (ADR-0047). Plain SQL with no imports, so the registry
// Workflow, the slot rebuild and the declarations loader all read one definition of a public owner.

// SQLite folds case for ASCII only, and the register writes an owner in capitals or not: each word in all
// three spellings.
const nameHas = (patterns: string[]) =>
  `(${patterns
    .flatMap((p) => [p.toUpperCase(), p.replace(/\p{L}/u, (c) => c.toUpperCase()), p])
    .map((p) => `name LIKE '${p}'`)
    .join(' OR ')})`;
const MUNICIPALITY = nameHas(['община%', 'столична община%']);
const STATE = nameHas([
  '%министерство%',
  '%министър%',
  '%държавата%',
  'държава%',
  '%народна банка%',
]);
// A contracting authority of these kinds, with no partida of a trade company, is a public body.
const PUBLIC_BODY_TYPES = [
  'Публичноправна организация',
  'Министерство или всякакъв друг национален или федерален орган, включително техни регионални или местни подразделения',
  'Орган на централната власт',
  'Национална или федерална агенция/служба',
  'Регионален или местен орган',
  'Местен орган',
  'Регионална или местна агенция/служба',
];
const SHARE = (column: string) =>
  `CASE WHEN ${column} IS NULL OR trim(${column}) = '' THEN NULL
     ELSE CAST(REPLACE(REPLACE(trim(${column}), ' ', ''), ',', '.') AS REAL) END`;
const PUBLIC_BODY = `public_body AS (
    SELECT substr(id, 6) eik, type_group = 'община' municipal FROM authorities
    WHERE id GLOB 'auth:[0-9]*' AND type IN (${PUBLIC_BODY_TYPES.map((t) => `'${t}'`).join(', ')})
      AND substr(id, 6) NOT IN (SELECT eik FROM registry_deeds WHERE outcome = 'ok')
  )`;
// Every standing owner of every company, persons included: a person among the owners is a private owner.
const OWNERS = `owners AS (
    SELECT r.eik, r.subject_kind kind, r.subject_id owner, r.subject_name name, r.role,
      ${SHARE('r.share')} amount
    FROM registry_roles r
    WHERE r.role IN ('sole_owner', 'partner') AND r.removed_on IS NULL AND r.uncertain_after IS NULL
  ), capital AS (
    SELECT eik, SUM(amount) total FROM owners WHERE role = 'partner' GROUP BY eik
  )`;
// Each owner judged against the companies already known to be public; `controls` is the single-owner rule.
const JUDGED = `judged AS (
    SELECT o.eik, o.role, o.owner, o.name, o.amount,
      COALESCE(o.kind = 'entity' AND (pb.eik IS NOT NULL OR ${MUNICIPALITY} OR ${STATE}
        OR o.owner IN (SELECT eik FROM state_owned_eik WHERE ownership_kind = 'state')
        OR po.eik IS NOT NULL), 0) public,
      COALESCE(o.kind = 'entity' AND (${MUNICIPALITY} OR pb.municipal
        OR po.ownership_kind = 'municipal'), 0) municipal,
      COALESCE(o.role = 'sole_owner' OR o.amount * 2 > c.total, 0) controls,
      COALESCE(o.kind = 'entity'
        AND o.owner NOT IN (SELECT eik FROM registry_deeds WHERE outcome = 'ok'), 0) unread
    FROM owners o
    LEFT JOIN capital c ON c.eik = o.eik
    LEFT JOIN public_body pb ON pb.eik = o.owner
    LEFT JOIN public_owned_eik po ON po.eik = o.owner
  )`;

// A company public by the owners it has as a whole, not by one of them: every standing owner public, shares
// recorded or not; or public owners together over half of a capital whose every share is recorded. Run after
// the single-owner pass and repeated, so a company held through one found here is found on the next pass.
const PUBLIC_TOGETHER = `INSERT OR IGNORE INTO public_owned_eik (eik, ownership_kind)
  WITH ${OWNERS}, ${PUBLIC_BODY}, ${JUDGED}, companies AS (
    SELECT eik, COUNT(*) owners, SUM(public) public_owners,
      MAX(public AND controls) controlled, MAX(public AND controls AND municipal) controlled_municipal,
      MAX(public AND municipal) municipal,
      SUM(role = 'partner') partners, SUM(role = 'partner' AND amount > 0) priced,
      SUM(CASE WHEN role = 'partner' THEN amount END) capital,
      SUM(CASE WHEN role = 'partner' AND public THEN amount END) public_capital
    FROM judged GROUP BY eik
  )
  SELECT eik, CASE WHEN (controlled AND controlled_municipal) OR (NOT controlled AND municipal)
    THEN 'municipal' ELSE 'state' END
  FROM companies
  WHERE controlled = 1 OR public_owners = owners
    OR (public_owners > 0 AND partners = owners AND priced = partners AND capital > 0
      AND public_capital * 2 > capital)`;

/** Public ownership the Trade Register records (ADR-0047), for the refresh to read: a company whose standing
 *  sole owner, or partner with more than half of the partners' capital, is the state, a ministry, a
 *  municipality, another public body or a company already public — or whose standing owners are all public,
 *  or together hold more than half of a fully recorded capital. Municipal when a municipality holds it,
 *  directly or through its companies. */
export const PUBLIC_OWNERSHIP_SQL = [
  `CREATE TABLE IF NOT EXISTS state_owned_eik (
    eik TEXT PRIMARY KEY,
    ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal', 'mixed')),
    canonical_name TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS public_owned_eik (
    eik TEXT PRIMARY KEY,
    ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal')))`,
  `DELETE FROM public_owned_eik`,
  `INSERT INTO public_owned_eik (eik, ownership_kind)
  WITH RECURSIVE owners AS (
    SELECT r.eik, r.subject_id owner, r.subject_name name, r.role,
      CAST(REPLACE(REPLACE(trim(r.share), ' ', ''), ',', '.') AS REAL) amount
    FROM registry_roles r
    WHERE r.subject_kind = 'entity' AND r.role IN ('sole_owner', 'partner')
      AND r.removed_on IS NULL AND r.uncertain_after IS NULL
  ), capital AS (
    SELECT eik, SUM(CAST(REPLACE(REPLACE(trim(share), ' ', ''), ',', '.') AS REAL)) total
    FROM registry_roles
    WHERE role = 'partner' AND removed_on IS NULL AND uncertain_after IS NULL
    GROUP BY eik
  ), controlled AS (
    SELECT o.eik, o.owner, o.name FROM owners o LEFT JOIN capital c ON c.eik = o.eik
    WHERE o.role = 'sole_owner' OR o.amount * 2 > c.total
  ), ${PUBLIC_BODY}, public_owned(eik, kind, depth) AS (
    SELECT c.eik, CASE WHEN ${MUNICIPALITY} OR pb.municipal THEN 'municipal' ELSE 'state' END, 0
    FROM controlled c LEFT JOIN public_body pb ON pb.eik = c.owner
    WHERE pb.eik IS NOT NULL OR ${MUNICIPALITY} OR ${STATE}
      OR c.owner IN (SELECT eik FROM state_owned_eik WHERE ownership_kind = 'state')
    UNION
    SELECT c.eik, p.kind, p.depth + 1 FROM controlled c JOIN public_owned p ON p.eik = c.owner
    WHERE p.depth < 4
  )
  SELECT eik, MIN(kind) FROM public_owned GROUP BY eik`,
  PUBLIC_TOGETHER,
  PUBLIC_TOGETHER,
  PUBLIC_TOGETHER,
  PUBLIC_TOGETHER,
];

/** The companies whose ownership cannot be settled yet: not public, with a public owner beside an owner
 *  company whose partida has not been read or beside a share the register does not record. One row per
 *  standing owner of each such company — `unread` marks the owners whose partida would settle it. */
export const PUBLIC_OWNER_UNSETTLED_SQL = `WITH ${OWNERS}, ${PUBLIC_BODY}, ${JUDGED}
  SELECT eik, owner, name, public, public = 0 AND unread = 1 AS unread FROM judged
  WHERE eik IN (
    SELECT eik FROM judged
    WHERE eik NOT IN (SELECT eik FROM public_owned_eik) AND eik NOT IN (SELECT eik FROM state_owned_eik)
    GROUP BY eik
    HAVING MAX(public) = 1
      AND (MAX(public = 0 AND unread = 1) = 1 OR MAX(role = 'partner' AND COALESCE(amount, 0) <= 0) = 1)
  )
  ORDER BY eik, owner`;
