// The evidence ladder (issue #279 §5, ADR-0033 decision 1). Pure: registry facts in, verdict out. Zero
// network.
//
// Six outcomes, FIRST MATCH WINS:
//   1 bar_joint_stock  АД / ЕАД / КДА — never published, whatever follows
//   2 document         the declarant's full name is a person standing in an ownership or manager role
//   3 confirmed        declared seat == registered seat, or the declarant wrote the ЕИК
//   4 refuted          own stake only: registered in no role now, and the ownership record as it stands
//                      predates the declared period — the register covers it and does not name them
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
// role since which entry, the legal form, the seat — never the register asked from here.

import {
  liveHolders,
  fullSubsetMatch,
  personTokens,
  normalizeSettlement,
  registrySeat,
  registryLegalForm,
  latestOwnershipEntryDate,
  OWNERSHIP_FIELDS,
  MANAGER_FIELD,
  ROLE_FIELDS,
} from './deed.mjs';

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
export const RULES_VERSION = 'tr-rules-4';

/** Rung 2 needs a real three-part Bulgarian name (ЗГР чл. 9). Two tokens is the homonym risk itself. */
const MIN_NAME_TOKENS = 3;

/**
 * The CLOSED vocabulary a sealed `matched_fact` may take: `seat:<SETTLEMENT>`, `role:owner:<FIELD>`,
 * `role:manager:<FIELD>`, or `eik`. `<FIELD>` is the register field that named the holder — its
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
  /^(?:seat:\p{Lu}[\p{Lu}-]*(?: \p{Lu}[\p{Lu}-]*)?|role:(?:owner|manager):(?:\d{5}|CR_F_\d+[a-z]?_L)|eik)$/u;

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

/**
 * Find the declarant among the persons standing in the given fields.
 * Matching happens per HOLDER — never across two — because combining tokens across the people of one
 * field is the libel bug.
 * @returns {{field:string, entryNumber:string|null, entryDate:string|null}|null}
 */
function findPerson(registry, name, fields) {
  for (const holder of liveHolders(registry, fields)) {
    if (fullSubsetMatch(name, holder.name)) {
      return { field: holder.field, entryNumber: holder.entryNumber, entryDate: holder.entryDate };
    }
  }
  return null;
}

function findHistoricalPerson(registry, name, fields, year) {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;
  const key = (v) => String(v).normalize('NFC').trim().toLocaleUpperCase('bg').replace(/\s+/g, ' ');
  const day = (v) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v ?? '') &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v;
  return (
    (registry.endedHolders ?? []).find(
      (h) =>
        fields.includes(h.field) &&
        key(h.name) === key(name) &&
        h.entryNumber &&
        day(h.entryDate) &&
        day(h.endedOn) &&
        h.entryDate < h.endedOn &&
        h.entryDate <= `${year}-12-31` &&
        h.endedOn > `${year}-01-01`,
    ) ?? null
  );
}

/**
 * The registered seat, when it matches one THIS person declared for THIS company and was in force for the
 * declared period. Shared by rung 3 (which publishes on it) and rung 2's company-identity corroborator.
 *
 * R10: seats move. A company that relocated INTO the declared settlement afterwards would confirm falsely,
 * so the registered seat must predate the period.
 *
 * A null `firstDeclaredYear` FAILS the guard rather than skipping it. `load.mjs` passes null whenever no
 * history row carried a parseable year, and an unknown year is not a satisfied temporal test — it is the
 * absence of one. Reading it as „covers the period" made the weakest rung the only one with no temporal
 * check, on exactly the links where we know least, and rung 4 already refuses to run without a year on the
 * same ground. The undated-SEAT leg is different and stays: a seat with no entry date is checkable — a
 * known year is still on the other side.
 *
 * @returns {{settlement:string, entryDate:string|null}|null}
 */
function matchDeclaredSeat(registry, declaredSeats, firstDeclaredYear) {
  const seat = registrySeat(registry);
  // Empty NEVER matches — otherwise every link with no seat data on either side rubber-stamps itself.
  if (seat.settlement === '') return null;
  if (firstDeclaredYear == null) return null;
  if (seat.entryDate != null && seat.entryDate > `${firstDeclaredYear}-12-31`) return null;
  const declared = declaredSeats.map(normalizeSettlement).filter((s) => s !== '');
  return declared.includes(seat.settlement) ? seat : null;
}

/**
 * Decide the evidence for one link.
 *
 * @param {object} input
 * @param {object|null} input.registry          the company's registry facts (deed.mjs `registryFacts`);
 *                                              null only when `outsideTr`
 * @param {boolean}     [input.outsideTr]       the ЕИК is not in the register at all
 * @param {string}      input.declarantName     the office-holder's name as filed
 * @param {string[]}    [input.declaredSeats]   seats declared BY THIS PERSON FOR THIS COMPANY only —
 *                                              4.9% of company-name keys carry more than one distinct
 *                                              declared seat, so a company-only key would let one
 *                                              person's seat confirm another person's link
 * @param {boolean}     [input.declaredEik]     the declarant wrote the ЕИК in the declaration
 * @param {number|null} [input.firstDeclaredYear]
 * @param {'self'|'family'} [input.scope]
 * @param {boolean}     [input.nameGloballyUnique] AND-gate on the WEAKEST rung only
 * @param {boolean}     [input.companyNameDistinctive] the declared фирма is unlikely to have a national
 *                                              twin. Gates an UNCORROBORATED rung 2 (ADR-0035).
 *                                              Defaults to FALSE: a caller that forgets it withholds.
 * @returns {{kind:string, publishable:boolean, registryRole:string|null, matchedFact:string|null,
 *            entryNumber:string|null, entryDate:string|null, rulesVersion:string,
 *            shortName:boolean, latinInName:boolean}}
 */
export function evidenceVerdict(input) {
  const {
    registry,
    outsideTr = false,
    declarantName,
    declaredSeats = [],
    declaredEik = false,
    firstDeclaredYear = null,
    scope = 'self',
    nameGloballyUnique = true,
    // Fail-CLOSED, unlike `nameGloballyUnique` above. That one's permissive default is bounded — it gates
    // only the weakest rung. This one gates the PRIMARY publishing rung, so a caller that forgets to pass
    // it must withhold rather than publish a claim naming a real person against a company we did not
    // establish. There is exactly one production caller (load.mjs) and it passes it explicitly.
    companyNameDistinctive = false,
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

  // The registered seat, matched against what THIS person declared for THIS company, with R10's temporal
  // guard applied. Computed once and consumed by two rungs: rung 3 publishes „Потвърдено" on it, and rung 2
  // uses it as a COMPANY-IDENTITY corroborator. One implementation, because two copies of "what counts as a
  // seat match" would eventually disagree about which links may be published.
  const matchedSeat = matchDeclaredSeat(registry, declaredSeats, firstDeclaredYear);

  // ── rung 2 ──────────────────────────────────────────────────────────────────
  // Only a full three-token name may assert. A Latin homoglyph makes the name a non-match rather than
  // a false match — company-name-key.ts's posture, applied to people.
  //
  // The company gate (ADR-0035). A name match proves someone with these three tokens is registered in the
  // company we LOOKED UP — never that this is the company the official declared. `resolveEntity` picks the
  // sole WINNER holding the declared name and `nameGloballyUnique` ranges over bidders only, so an official
  // whose real company never bid resolves to a same-named winner, and a homonym registered in that winner
  // completes a link false in both halves. Before rung 2 may assert, something other than the фирма must
  // say the company is the declared one:
  //   • the declarant wrote the ЕИК — the national identifier resolves it outright (ADR-0028); or
  //   • the declared seat matches the registered one — a twin in another town is excluded; or
  //   • the фирма is distinctive enough that a national twin is improbable in the first place.
  // The third is a bound, not a proof, and it is COUNTED (`documentUncorroborated`) so F8 can decide from
  // the measured residual whether to tighten to the first two.
  const companyCorroborated = declaredEik || matchedSeat != null;
  const eligibleForDocument = !telemetry.shortName && !telemetry.latinInName;
  if (eligibleForDocument) {
    const liveOwner = findPerson(registry, declarantName, OWNERSHIP_FIELDS);
    const liveManager = liveOwner ? null : findPerson(registry, declarantName, [MANAGER_FIELD]);
    const owner =
      liveOwner ??
      (liveManager
        ? null
        : findHistoricalPerson(registry, declarantName, OWNERSHIP_FIELDS, firstDeclaredYear));
    const manager = owner
      ? null
      : (liveManager ??
        findHistoricalPerson(registry, declarantName, [MANAGER_FIELD], firstDeclaredYear));
    const hit = owner ?? manager;
    if (hit && !companyCorroborated && !companyNameDistinctive) {
      // A DISTINCT withholding kind, not a fall-through to `unknown`. „We matched a person but could not
      // establish the company" and „we matched nothing" are different facts about a link, and the review
      // queue (which is sealed for held links precisely to be reviewable) has to be able to tell them
      // apart. It never publishes, and it carries no role or fact — asserting either would leak the very
      // claim the rung just refused to make.
      return verdict('document_uncorroborated', false);
    }
    if (owner) {
      return verdict('document', true, {
        registryRole: 'owner',
        matchedFact: `role:owner:${owner.field}`,
        entryNumber: owner.entryNumber,
        entryDate: owner.entryDate,
        roleEndedOn: owner.endedOn ?? null,
      });
    }
    if (manager) {
      return verdict('document', true, {
        registryRole: 'manager',
        matchedFact: `role:manager:${manager.field}`,
        entryNumber: manager.entryNumber,
        entryDate: manager.entryDate,
        roleEndedOn: manager.endedOn ?? null,
      });
    }
  }

  // ── rung 3 ──────────────────────────────────────────────────────────────────
  // The weakest publishing rung, so it carries the extra AND-gate: a nationally shared company name
  // cannot ride it (ADR-0017's holding, carried forward). The stronger „Документ" rung above is not
  // gated — the register named this person in THIS company, which makes the name key moot.
  // The declared-ЕИК leg is NOT name-gated. ADR-0028: the ЕИК is the identity, not the name, so it
  // resolves the company deterministically even behind a nationally shared фирма — which is exactly the
  // case ADR-0017 was written about.
  if (declaredEik) return verdict('confirmed', true, { matchedFact: 'eik' });

  // The SEAT leg is name-gated, and only this one. ADR-0017's holding carried forward: a name shared by
  // two ЕИК cannot support a name-derived identity claim. The seat still rescues a GENERIC name — that
  // is the whole point of the rung — it just cannot rescue a NATIONALLY SHARED one.
  if (nameGloballyUnique && matchedSeat != null) {
    return verdict('confirmed', true, {
      matchedFact: `seat:${matchedSeat.settlement}`,
      entryDate: matchedSeat.entryDate,
    });
  }

  // ── rung 4 ──────────────────────────────────────────────────────────────────
  // OWN stakes only. For a family stake the registered owner is the relative, whose name we neither
  // store nor check, so absence of the OFFICIAL from the register is evidence of nothing. An early branch,
  // not a caller convention.
  if (scope === 'self' && firstDeclaredYear != null) {
    const stillPresent = findPerson(registry, declarantName, ROLE_FIELDS);
    const latest = latestOwnershipEntryDate(registry);
    const inRereg =
      latest != null && latest >= REREGISTRATION_START && latest <= REREGISTRATION_END;
    if (!stillPresent && latest != null && !inRereg && latest < `${firstDeclaredYear}-01-01`) {
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
export function reconcileTermination({ registry, declarantName, scope = 'self' }) {
  // Family first, structurally: there is nothing to look for, and looking would be an attempt to
  // identify the relative.
  if (scope !== 'self' || registry == null) return { terminated: true, label: null };

  if (findPerson(registry, declarantName, OWNERSHIP_FIELDS)) {
    return { terminated: false, label: 'owner_today' };
  }
  if (findPerson(registry, declarantName, [MANAGER_FIELD])) {
    return { terminated: true, label: 'manager_today' };
  }
  return { terminated: true, label: null };
}
