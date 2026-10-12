/**
 * Public stakes in joint-stock companies whose shareholders the Trade Register does not record: the register
 * lists the sole owner of an ЕАД or the partners of an ООД, never the shareholders of an АД. Data, not a
 * heuristic — each stake as its public owner reports it in its own published accounts, with the source and the
 * date it holds for. A stake held through another company (`via`, that company's ЕИК) is indirect: it is shown
 * as such and never added to a direct one.
 */
export interface DocumentedPublicStake {
  eik: string;
  owner: string;
  kind: 'state' | 'municipal' | 'bnb';
  pct: number;
  via?: string;
  source: string;
  asOf: string;
}

const BNB_2024 = 'Българска народна банка, Годишен отчет 2024, бележки към финансовите отчети';

export const DOCUMENTED_PUBLIC_STAKES: readonly DocumentedPublicStake[] = [
  // „Асоциирани предприятия“: участие 25.00%.
  {
    eik: '175327305',
    owner: 'Българска народна банка',
    kind: 'bnb',
    pct: 25,
    source: BNB_2024,
    asOf: '2024-12-31',
  },
  // „Асоциирани предприятия“: участие 36.11%.
  {
    eik: '201230426',
    owner: 'Българска народна банка',
    kind: 'bnb',
    pct: 36.11,
    source: BNB_2024,
    asOf: '2024-12-31',
  },
  // „Печатница на БНБ“ АД притежава 30% от акциите; БНБ е мажоритарен собственик на печатницата.
  {
    eik: '202815436',
    owner: '„Печатница на БНБ“ АД',
    kind: 'bnb',
    pct: 30,
    via: '130800278',
    source: BNB_2024,
    asOf: '2024-12-31',
  },
];

// SQLite folds case for ASCII only, and the register writes an owner in capitals or not: each pattern in the three
// spellings the register uses.
const spellings = (p: string) => [
  p.toLowerCase(),
  p.toLowerCase().replace(/\p{L}/u, (c) => c.toUpperCase()),
  p.toUpperCase(),
];
const nameLike = (column: string, patterns: string[]) =>
  patterns
    .flatMap(spellings)
    .map((p) => `${column} LIKE '${p}'`)
    .join(' OR ');
/** The owners whose stake is public by their name: the state through a ministry or a minister, a municipality,
 *  the central bank. */
const PUBLIC_OWNER_NAMES = [
  '%министерство%',
  '%министъра%',
  '%държавата%',
  'държава%',
  'община%',
  'столична община%',
  '%народна банка%',
];

/**
 * SQL: the company `eik` (an SQL expression) has a public stake the sources establish, however small — a standing
 * owner the register records that is the state, a municipality, the central bank, another public body with no
 * trade partida or a public company; a public enterprise itself; or a documented stake
 * (DOCUMENTED_PUBLIC_STAKES). The same sources as the label under the company's name.
 */
export function publicStakeSql(eik: string): string {
  // The empty string keeps the list valid SQL however short it gets; no ЕИК is empty.
  const documented = ["''", ...DOCUMENTED_PUBLIC_STAKES.map((s) => `'${s.eik}'`)].join(', ');
  return `(${eik} IN (${documented})
    OR ${eik} IN (SELECT ps_s.eik FROM state_owned_eik ps_s)
    OR ${eik} IN (SELECT ps_p.eik FROM public_owned_eik ps_p)
    OR EXISTS (SELECT 1 FROM registry_roles ps_o
      WHERE ps_o.eik = ${eik} AND ps_o.subject_kind = 'entity' AND ps_o.role IN ('sole_owner', 'partner')
        AND ps_o.removed_on IS NULL AND ps_o.uncertain_after IS NULL
        AND (${nameLike('ps_o.subject_name', PUBLIC_OWNER_NAMES)}
          OR ps_o.subject_id IN (SELECT ps_s2.eik FROM state_owned_eik ps_s2)
          OR ps_o.subject_id IN (SELECT ps_p2.eik FROM public_owned_eik ps_p2)
          OR (EXISTS (SELECT 1 FROM authorities ps_a WHERE ps_a.id = 'auth:' || ps_o.subject_id)
            AND NOT EXISTS (SELECT 1 FROM registry_deeds ps_d WHERE ps_d.eik = ps_o.subject_id AND ps_d.outcome = 'ok')))))`;
}

/** The register's roles that own a part of the company: a share, not a seat. */
export const OWNER_ROLES = ['sole_owner', 'partner', 'trader'] as const;

/** SQL: the registry role `alias` is a seat — not ownership — in a company with a public stake. Its contracts are
 *  not the person's, as a seat at a public enterprise's are not (ADR-0047 §2). */
export const publicStakeSeatSql = (alias: string): string =>
  `(${alias}.role NOT IN (${OWNER_ROLES.map((r) => `'${r}'`).join(', ')}) AND ${publicStakeSql(`${alias}.eik`)})`;
