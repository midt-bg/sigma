// The evidence ladder (issue #279 §5, ADR-0033 decision 1). Pure: registry facts in, verdict out. Zero
// network.
//
// Six outcomes, FIRST MATCH WINS:
//   1 bar_joint_stock  АД / ЕАД / КДА — never published, whatever follows
//   2 document         the register shows the declarant in an ownership or manager role, now or before
//   3 confirmed        the declarant wrote the ЕИК, or — for a relative's stake — the register shows a
//                      holder the declaration names for that stake
//   4 refuted          own stake only: registered in no role at any time, and the ownership record as it
//                      stands predates the declared period — the register covers it and does not name them
//   5 unknown          everything else — held
//   6 outside_tr       not in the register at all (ДЗЗД, БУЛСТАТ associations) — held
//
// WHAT THIS ESTABLISHES, precisely: the identity of the COMPANY — that the company behind the declared
// name is the same legal entity as the winner we matched. It does NOT establish that the official owns
// it; that claim comes from their own filed declaration and is not a heuristic at all. The failure mode
// of a wrong match is therefore not an invented ownership claim but a real official attached to the
// WRONG company's ЕИК, contracts and money. Still a false public statement about a named person, which
// is why rung 2 requires a full three-token subset match against a single registered person, and why the
// filters that can only withhold are kept (ADR-0033 decision 2).
//
// The facts are the registry layer's (ADR-0041, deed.mjs): the register's own records of who holds which
// role since which entry, the legal form — never the register asked from here.

import {
  liveHolders,
  personTokens,
  registryLegalForm,
  latestOwnershipEntryDate,
  OWNERSHIP_FIELDS,
  MANAGER_FIELD,
} from './deed.mjs';
import { declarantNameKey } from '../cacbg/source-identity.mjs';
import { personNamesAlike } from '../../packages/shared/src/person-identity.ts';

/**
 * Version of the RULES, not of the code. §8's monotonicity gate keys on this: a previously published
 * link disappearing under an UNCHANGED rules version is a hard finding; under a changed one it is an
 * expected diff. Bump it whenever a rung's meaning changes.
 *
 * `tr-rules-2` records the evidence regime that #309 and ADR-0035 introduced and that `tr-rules-1`
 * never described. Under `tr-rules-1` a link could publish with NO registry evidence at all — the
 * `interest_link_evidence` table did not yet exist. Publishing now requires a seal, and rung 2 also
 * requires something beyond the company name to establish the company.
 *
 * `tr-rules-3` moves the evidence to the registry layer (ADR-0041). The rungs ask the same questions,
 * but of a different reading of the register: its own records — each holder its own row, a role standing
 * until the entry that leaves it out — instead of the HTML the portal rendered, and the entry a
 * „Документ" cites is the one that added the holder rather than the field's latest. A different reading
 * is exactly what this constant exists to record.
 */
// r4 also permits an ended, dated role overlapping the first declared year to
// corroborate company identity. The company gate is unchanged. Absence today
// does not refute a documented past role; current-role reconciliation stays separate.
// r6 preserves distinguishing company-name prefixes and excludes collective holders from personal-role evidence.
// r7: the declarant identifier joins one person's documents across offices (ADR-0042); links follow the
// merged person ids, so a key published under r6 may reappear under a new id. Old addresses resolve
// through the aliases.
// r8: the company is its ЕИК and the register's people are the only evidence that it is the declared one.
// The seat and the name-distinctiveness gate are gone; a person matches at any time (standing, ended, or
// of unclear end) and under a spelling variant of the name; a relative's stake is confirmed by the
// register showing the relative the declaration names.
export const RULES_VERSION = 'tr-rules-8';

/** Rung 2 needs a real three-part Bulgarian name (ЗГР чл. 9). Two tokens is the homonym risk itself. */
const MIN_NAME_TOKENS = 3;

/**
 * The CLOSED vocabulary a sealed `matched_fact` may take: `role:owner:<FIELD>`, `role:manager:<FIELD>`,
 * `relative:owner:<FIELD>`, `relative:manager:<FIELD>`, `eik`, or — sealed before `tr-rules-8` —
 * `seat:<SETTLEMENT>`. `<FIELD>` is the register field that named the holder — its
 * five-digit ident (`00190`) or, on a verdict sealed before `tr-rules-3`, the portal's code
 * (`CR_F_19_L`). It must NEVER carry the matched NAME: names are read only to produce a boolean
 * (#279 §9, ADR-0033 decision 5).
 *
 * The seat token bound is the whole rail. `seat:` is a legitimate prefix, so an unbounded settlement
 * pattern admits `seat:ИВАН ПЕТРОВ ГЕОРГИЕВ` — a full three-part Bulgarian name (ЗГР чл. 9) wearing an
 * allowed prefix, which is exactly the value a mis-read of the seat would produce and exactly what the
 * rail exists to reject. A settlement is one or two tokens („СОФИЯ", „ВЕЛИКО ТЪРНОВО", „ГЕНЕРАЛ
 * ТОШЕВО"); a three-part name is exactly three. Bounding at two separates them cleanly, and a rarer
 * 3-token seat stops the run for a human rather than publishing — the correct direction for a rail
 * whose failure mode is putting somebody's name on a served column.
 *
 * Defined ONCE and consumed by both the writer (load.mjs) and the audit, so the two cannot drift into
 * a state where the gate permits what the writer emits.
 */
export const MATCHED_FACT_RE =
  /^(?:seat:\p{Lu}[\p{Lu}-]*(?: \p{Lu}[\p{Lu}-]*)?|(?:role|relative):(?:owner|manager):(?:\d{5}|CR_F_\d+[a-z]?_L)|eik)$/u;

/** True when `fact` is a member of the closed vocabulary. `null` is legal — a rung may match no fact. */
export function isSealedFact(fact) {
  return fact == null || MATCHED_FACT_RE.test(String(fact));
}

// Court-registered companies were re-registered into the Търговски регистър in a single administrative
// push, which flattened their entry dates into this window. „Strictly before the declared period"
// certifies nothing when the date is an artefact of the migration rather than of the ownership, so the
// refutation rung is suppressed inside it (R13). A suppressed refutation falls through to `unknown` —
// held, not published, which is the safe direction.
const REREGISTRATION_START = '2011-01-01';
const REREGISTRATION_END = '2012-12-31';

const HASH = /^[a-f0-9]{64}$/i;

/**
 * The one registered person a name designates in this partida. By identifier when the declarant's is
 * proven; otherwise every holder — standing, ended or of unclear end — whose name is the declared one, or
 * failing that a spelling variant of it (a surname added, dropped or taken on marriage, one typo). They
 * must all be one person: two identifiers under the name designate nobody.
 * Matching happens per HOLDER — never across two — because combining tokens across the people of one
 * field is the libel bug.
 */
function personMatch(registry, name, registryIndent) {
  if (registryIndent != null) {
    if (!/^[a-f0-9]{64}$/.test(registryIndent)) throw new Error('Invalid proven registry identity');
    return (holder) => holder.subjectId === registryIndent;
  }
  const all = [...(registry.holders ?? []), ...(registry.endedHolders ?? [])];
  const key = declarantNameKey(name);
  const exact = all.filter((h) => declarantNameKey(h.name) === key);
  const named = exact.length ? exact : all.filter((h) => personNamesAlike(name, h.name));
  const ids = new Set(
    named.filter((h) => HASH.test(h.subjectId ?? '')).map((h) => h.subjectId.toLowerCase()),
  );
  if (ids.size > 1) return () => false;
  const [indent] = ids;
  if (indent) return (holder) => holder.subjectId?.toLowerCase() === indent;
  const names = new Set(named.map((h) => declarantNameKey(h.name)));
  return names.size === 1 ? (holder) => names.has(declarantNameKey(holder.name)) : () => false;
}

/** The person standing now in one of the fields. */
function findPerson(registry, name, fields, registryIndent) {
  const holder = liveHolders(registry, fields).find(personMatch(registry, name, registryIndent));
  return holder
    ? { field: holder.field, entryNumber: holder.entryNumber, entryDate: holder.entryDate }
    : null;
}

const day = (v) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v ?? '') &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
/** An ended role with a real entry that lasted: dated, and ended after it began. A role of unclear end has no
 *  end date to check. */
const lasted = (h) =>
  h.endedOn == null ||
  (!!h.entryNumber && day(h.entryDate) && day(h.endedOn) && h.entryDate < h.endedOn);

/** The person in one of the fields at any time: standing first, else the role that ended last. */
function findEverPerson(registry, name, fields, registryIndent) {
  const live = findPerson(registry, name, fields, registryIndent);
  if (live) return { ...live, endedOn: null };
  const matches = personMatch(registry, name, registryIndent);
  const past = (registry.endedHolders ?? [])
    .filter((h) => fields.includes(h.field) && lasted(h) && matches(h))
    .sort((a, b) => String(b.endedOn ?? '9999').localeCompare(String(a.endedOn ?? '9999')))[0];
  return past
    ? {
        field: past.field,
        entryNumber: past.entryNumber,
        entryDate: past.entryDate,
        endedOn: past.endedOn ?? null,
      }
    : null;
}

/** Owner before manager, each standing before past. */
function findRole(registry, name, registryIndent) {
  const at = (fields) => findPerson(registry, name, fields, registryIndent);
  const ever = (fields) => findEverPerson(registry, name, fields, registryIndent);
  const owner = at(OWNERSHIP_FIELDS);
  if (owner) return { role: 'owner', ...owner, endedOn: null };
  const manager = at([MANAGER_FIELD]);
  if (manager) return { role: 'manager', ...manager, endedOn: null };
  const pastOwner = ever(OWNERSHIP_FIELDS);
  if (pastOwner) return { role: 'owner', ...pastOwner };
  const pastManager = ever([MANAGER_FIELD]);
  return pastManager ? { role: 'manager', ...pastManager } : null;
}

/**
 * Decide the evidence for one link.
 *
 * The company is its ЕИК — declared, or the one the declared name leads to (load.mjs). What is left to
 * establish is that the register agrees the company is the declared one, and only the register's own
 * record of the people in it can say so; a seat says nothing an ЕИК does not.
 *
 * @param {object} input
 * @param {object|null} input.registry          the company's registry facts (deed.mjs `registryFacts`);
 *                                              null only when `outsideTr`
 * @param {boolean}     [input.outsideTr]       the ЕИК is not in the register at all
 * @param {string}      input.declarantName     the office-holder's name as filed
 * @param {string|null} [input.registryIndent]  the declarant's proven registry identifier
 * @param {boolean}     [input.declaredEik]     the declarant wrote the ЕИК in the declaration
 * @param {number|null} [input.firstDeclaredYear]
 * @param {'self'|'family'} [input.scope]
 * @param {string[]}    [input.relativeNames]   family only: the holders the declaration names for this
 *                                              stake. Internal — read to produce a boolean, never kept
 * @returns {{kind:string, publishable:boolean, registryRole:string|null, matchedFact:string|null,
 *            entryNumber:string|null, entryDate:string|null, rulesVersion:string,
 *            shortName:boolean, latinInName:boolean}}
 */
export function evidenceVerdict(input) {
  const {
    registry,
    outsideTr = false,
    declarantName,
    registryIndent,
    declaredEik = false,
    firstDeclaredYear = null,
    scope = 'self',
    relativeNames = [],
  } = input;

  const tokens = personTokens(declarantName);
  const telemetry = {
    rulesVersion: RULES_VERSION,
    // Counted, not silently dropped: a refusal we cannot see is a recall hole nobody can size.
    shortName: tokens.length < MIN_NAME_TOKENS,
    latinInName: /[A-Za-z]/.test(String(declarantName ?? '')),
  };
  const verdict = (kind, publishable, extra = {}) => ({
    kind,
    publishable,
    registryRole: null,
    matchedFact: null,
    entryNumber: null,
    entryDate: null,
    roleEndedOn: null,
    ...telemetry,
    ...extra,
  });

  if (outsideTr) return verdict('outside_tr', false);
  if (registry == null) {
    // Fail closed and loudly. Missing facts quietly downgraded to „unknown" are indistinguishable from a
    // real hold, and hide a gap that should stop the run.
    throw new Error('evidenceVerdict: registry facts are required unless outsideTr is set');
  }

  // ── rung 1 ──────────────────────────────────────────────────────────────────
  // A union of the register's code and the ЗТРРЮЛНЦ suffix; either saying joint-stock bars the link, and
  // neither able to say means we withhold rather than guess.
  const form = registryLegalForm(registry);
  if (form.verdict === 'joint_stock') return verdict('bar_joint_stock', false);
  if (form.verdict === 'unknown') return verdict('unknown', false);

  // ── rung 2 ──────────────────────────────────────────────────────────────────
  // The register shows the declarant in this partida, now or at any time: the company is theirs. Only a
  // full three-token name may assert. A Latin homoglyph makes the name a non-match rather than a false
  // match — company-name-key.ts's posture, applied to people.
  if (!telemetry.shortName && !telemetry.latinInName) {
    const hit = findRole(registry, declarantName, registryIndent);
    if (hit)
      return verdict('document', true, {
        registryRole: hit.role,
        matchedFact: `role:${hit.role}:${hit.field}`,
        entryNumber: hit.entryNumber,
        entryDate: hit.entryDate,
        roleEndedOn: hit.endedOn,
      });
  }

  // ── rung 3 ──────────────────────────────────────────────────────────────────
  // ADR-0028: a declared ЕИК is the company's identity.
  if (declaredEik) return verdict('confirmed', true, { matchedFact: 'eik' });
  // A relative's stake: the register shows a holder the declaration names for it. The fact records the
  // relative's role and field, never who they are, and the link carries no role of the official's.
  if (scope === 'family') {
    for (const name of relativeNames) {
      if (personTokens(name).length < MIN_NAME_TOKENS) continue;
      const hit = findRole(registry, name, null);
      if (hit)
        return verdict('confirmed', true, {
          matchedFact: `relative:${hit.role}:${hit.field}`,
          entryNumber: hit.entryNumber,
          entryDate: hit.entryDate,
        });
    }
  }

  // ── rung 4 ──────────────────────────────────────────────────────────────────
  // OWN stakes only. For a family stake the registered owner is the relative, so absence of the OFFICIAL
  // from the register is evidence of nothing. An early branch, not a caller convention.
  if (scope === 'self' && firstDeclaredYear != null) {
    const everPresent = findRole(registry, declarantName, registryIndent);
    const latest = latestOwnershipEntryDate(registry);
    const inRereg =
      latest != null && latest >= REREGISTRATION_START && latest <= REREGISTRATION_END;
    if (!everPresent && latest != null && !inRereg && latest < `${firstDeclaredYear}-01-01`) {
      return verdict('refuted', false, { entryDate: latest });
    }
  }

  // ── rung 5 ──────────────────────────────────────────────────────────────────
  return verdict('unknown', false);
}

/**
 * Reconcile a DECLARED termination against who is registered now (#279 §7).
 *
 * „Terminated" is an inference from silence — the commonest cause is a finished mandate, not a sale —
 * so ADR-0021 E11's withdrawal is checked against the register before it takes effect.
 *
 * Phase 1 uses `terminated` ONLY. `label` is computed but deliberately not rendered: „и към днешна
 * дата" asserts a present tense about a named person on evidence whose freshness is bounded by the
 * refresh cycle, and it is deferred behind an LIA addendum (ADR-0033 decision 4).
 *
 * @returns {{terminated:boolean, label:'owner_today'|'manager_today'|null}}
 */
export function reconcileTermination({ registry, declarantName, registryIndent, scope = 'self' }) {
  // Family first, structurally: there is nothing to look for, and looking would be an attempt to
  // identify the relative.
  if (scope !== 'self' || registry == null) return { terminated: true, label: null };

  if (findPerson(registry, declarantName, OWNERSHIP_FIELDS, registryIndent)) {
    return { terminated: false, label: 'owner_today' };
  }
  if (findPerson(registry, declarantName, [MANAGER_FIELD], registryIndent)) {
    return { terminated: true, label: 'manager_today' };
  }
  return { terminated: true, label: null };
}
