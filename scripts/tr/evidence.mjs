// The evidence ladder (issue #279 §5, ADR-0033 decision 1). Pure: deed in, verdict out. Zero network.
//
// Six outcomes, FIRST MATCH WINS:
//   1 bar_joint_stock  АД / ЕАД / КДА — never published, whatever follows
//   2 document         the declarant's full name is in a live CR_F_7/18/19/23_L entity
//   3 confirmed        declared seat == registered seat, or the declarant wrote the ЕИК
//   4 refuted          own stake only: absent from live state, and the live ownership record
//                      predates the declared period — the register covers it and does not name them
//   5 unknown          everything else — held
//   6 outside_tr       not in the register at all (ДЗЗД, БУЛСТАТ associations) — held
//
// WHAT THIS ESTABLISHES, precisely: the identity of the COMPANY — that the company behind the declared
// name is the same legal entity as the winner we matched. It does NOT establish that the official owns
// it; that claim comes from their own filed declaration and is not a heuristic at all. The failure mode
// of a wrong match is therefore not an invented ownership claim but a real official attached to the
// WRONG company's ЕИК, contracts and money. Still a false public statement about a named person, which
// is why rung 2 requires a full three-token subset match inside a single registry entity, and why the
// filters that can only withhold are kept (ADR-0033 decision 2).

import {
  liveFields,
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
 */
export const RULES_VERSION = 'tr-rules-1';

/** Rung 2 needs a real three-part Bulgarian name (ЗГР чл. 9). Two tokens is the homonym risk itself. */
const MIN_NAME_TOKENS = 3;

// Court-registered companies were re-registered into the Търговски регистър in a single administrative
// push, which flattened their entry dates into this window. „Strictly before the declared period"
// certifies nothing when the date is an artefact of the migration rather than of the ownership, so the
// refutation rung is suppressed inside it (R13). A suppressed refutation falls through to `unknown` —
// held, not published, which is the safe direction.
const REREGISTRATION_START = '2011-01-01';
const REREGISTRATION_END = '2012-12-31';

/**
 * Find the declarant inside the live entities of the given field codes.
 * Matching happens per ENTITY — never against a whole field — because one field routinely holds
 * several people and combining tokens across them is the libel bug.
 * @returns {{nameCode:string, entryNumber:string|null, entryDate:string|null}|null}
 */
function findPerson(deed, name, nameCodes) {
  for (const f of liveFields(deed, nameCodes)) {
    for (const entity of f.entities) {
      if (fullSubsetMatch(name, entity)) {
        return { nameCode: f.nameCode, entryNumber: f.entryNumber, entryDate: f.entryDate };
      }
    }
  }
  return null;
}

/**
 * Decide the evidence for one link.
 *
 * @param {object} input
 * @param {object|null} input.deed              parsed deed JSON; null only when `outsideTr`
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
 * @returns {{kind:string, publishable:boolean, registryRole:string|null, matchedFact:string|null,
 *            entryNumber:string|null, entryDate:string|null, rulesVersion:string,
 *            shortName:boolean, latinInName:boolean}}
 */
export function evidenceVerdict(input) {
  const {
    deed,
    outsideTr = false,
    declarantName,
    declaredSeats = [],
    declaredEik = false,
    firstDeclaredYear = null,
    scope = 'self',
    nameGloballyUnique = true,
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
    ...telemetry,
    ...extra,
  });

  if (outsideTr) return verdict('outside_tr', false);
  if (deed == null) {
    // Fail closed and loudly. A missing deed quietly downgraded to „unknown" is indistinguishable
    // from a real hold, and hides a cache gap that should stop the run.
    throw new Error('evidenceVerdict: deed is required unless outsideTr is set');
  }

  // ── rung 1 ──────────────────────────────────────────────────────────────────
  // A union of the numeric code and the ЗТРРЮЛНЦ suffix; either saying joint-stock bars the link, and
  // neither able to say means we withhold rather than guess.
  const form = registryLegalForm(deed);
  if (form.verdict === 'joint_stock') return verdict('bar_joint_stock', false);
  if (form.verdict === 'unknown') return verdict('unknown', false);

  // ── rung 2 ──────────────────────────────────────────────────────────────────
  // Only a full three-token name may assert. A Latin homoglyph makes the name a non-match rather than
  // a false match — company-name-key.ts's posture, applied to people.
  const eligibleForDocument = !telemetry.shortName && !telemetry.latinInName;
  if (eligibleForDocument) {
    const owner = findPerson(deed, declarantName, OWNERSHIP_FIELDS);
    if (owner) {
      return verdict('document', true, {
        registryRole: 'owner',
        matchedFact: `role:owner:${owner.nameCode}`,
        entryNumber: owner.entryNumber,
        entryDate: owner.entryDate,
      });
    }
    const manager = findPerson(deed, declarantName, [MANAGER_FIELD]);
    if (manager) {
      return verdict('document', true, {
        registryRole: 'manager',
        matchedFact: `role:manager:${manager.nameCode}`,
        entryNumber: manager.entryNumber,
        entryDate: manager.entryDate,
      });
    }
  }

  // ── rung 3 ──────────────────────────────────────────────────────────────────
  // The weakest publishing rung, so it carries the extra AND-gate: a nationally shared company name
  // cannot ride it (ADR-0017's holding, carried forward). The stronger „Документ" rung above is not
  // gated — the register named this person in THIS company, which makes the name key moot.
  // The declared-ЕИК leg is NOT name-gated. ADR-0028: the ЕИК is the identity, not the name, so it
  // resolves the company deterministically even behind a nationally shared фирма — which is exactly the
  // case ADR-0017 was written about. Gating it on name uniqueness would discard the strongest
  // identifier we have precisely where it is most needed.
  if (declaredEik) return verdict('confirmed', true, { matchedFact: 'eik' });

  // The SEAT leg is name-gated, and only this one. ADR-0017's holding carried forward: a name shared by
  // two ЕИК cannot support a name-derived identity claim. The seat still rescues a GENERIC name — that
  // is the whole point of the rung — it just cannot rescue a NATIONALLY SHARED one.
  if (nameGloballyUnique) {
    const seat = registrySeat(deed);
    // Empty NEVER confirms — otherwise every link with no seat data on either side rubber-stamps.
    if (seat.settlement !== '') {
      const declared = declaredSeats.map(normalizeSettlement).filter((s) => s !== '');
      // R10: the registered seat must have been in force for the declared period. Seats move, and a
      // company that relocated INTO the declared settlement afterwards would otherwise confirm falsely.
      const seatCoversPeriod =
        firstDeclaredYear == null ||
        seat.entryDate == null ||
        seat.entryDate <= `${firstDeclaredYear}-12-31`;
      if (seatCoversPeriod && declared.includes(seat.settlement)) {
        return verdict('confirmed', true, {
          matchedFact: `seat:${seat.settlement}`,
          entryDate: seat.entryDate,
        });
      }
    }
  }

  // ── rung 4 ──────────────────────────────────────────────────────────────────
  // OWN stakes only. For a family stake the registered owner is the relative, whose name we neither
  // store nor check, so absence of the OFFICIAL from the deed is evidence of nothing. An early branch,
  // not a caller convention.
  if (scope === 'self' && firstDeclaredYear != null) {
    const stillPresent = findPerson(deed, declarantName, ROLE_FIELDS);
    const latest = latestOwnershipEntryDate(deed);
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
 * Reconcile a DECLARED termination against the live deed (#279 §7).
 *
 * „Terminated" is an inference from silence — the commonest cause is a finished mandate, not a sale —
 * so ADR-0021 E11's withdrawal is checked against the register before it takes effect.
 *
 * Phase 1 uses `terminated` ONLY. `label` is computed but deliberately not rendered: „и към днешна
 * дата" asserts a present tense about a named person on evidence whose freshness is bounded by the
 * cache refresh cycle, and it is deferred behind an LIA addendum (ADR-0033 decision 4).
 *
 * @returns {{terminated:boolean, label:'owner_today'|'manager_today'|null}}
 */
export function reconcileTermination({ deed, declarantName, scope = 'self' }) {
  // Family first, structurally: there is nothing to look for, and looking would be an attempt to
  // identify the relative.
  if (scope !== 'self' || deed == null) return { terminated: true, label: null };

  if (findPerson(deed, declarantName, OWNERSHIP_FIELDS)) {
    return { terminated: false, label: 'owner_today' };
  }
  if (findPerson(deed, declarantName, [MANAGER_FIELD])) {
    return { terminated: true, label: 'manager_today' };
  }
  return { terminated: true, label: null };
}
