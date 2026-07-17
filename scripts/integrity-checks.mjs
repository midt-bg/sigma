// Sigma — hard reconciliation gate for the ETL pipeline (#97). Promotes the numbers
// normalize-raw.sql / precompute.sql merely PRINT (authority/company/flow rollups vs the
// contracts they summarise, EIK validity, date sanity, staging→domain counts) into asserted
// invariants that FAIL the import with a non-zero exit code on any numeric drift. The only
// prior hard guard was the FX check in import.mjs (assertFxPopulated*); this generalises it.
//
// Design: every check is a pure function taking an injected `runner(sql) => rows[]`, so the
// SAME logic runs against D1 (wrangler), local sqlite (sqlite3), and the test fixtures. Each
// returns { name, ok, skipped, detail }. assertIntegrity(runner) runs them all, prints a
// summary, and ends the process non-zero on the first real violation (collect-all-then-fail).
//
// Tolerance policy: the ONLY tolerance is EPS_EUR, for float reassociation when SUM()ing the
// REAL amount_eur column in different group orders. Every STRUCTURAL exclusion (a contract that
// attributes to no authority/bidder) is computed EXACTLY by row count and asserted to be 0 —
// never folded into the epsilon. See docs/integrity-gate.md.

// amount_eur is REAL euros (not integer cents). Summing ~200k euro-valued doubles grouped by
// authority vs summed flat can differ in the tail purely from float reassociation. Worst-case
// rounding error of a length-N sum is ~(N-1)·u·Σ|xᵢ| with u = 2⁻⁵³; at N≈2e5 and Σ≈5e10 € that is
// ~1 € per sum, so the rollup-of-subtotals vs flat difference is ~2 € worst case — EPS = 5 € clears
// it with margin. It cannot mask a real drop: a missing/duplicated/sign-flipped contract moves a
// sum by its whole value (the lowest kept amount_eur is ≫ 5 €), and structural gaps are caught by
// the exact orphan-row counts below, not by this epsilon. The bound is analytic; once the gate has
// run against the real corpus, tighten or confirm it against the observed tail (see
// docs/integrity-gate.md).
const EPS_EUR = 5.0;

function num(v) {
  return v === null || v === undefined ? 0 : Number(v);
}

function rows(runner, sql) {
  const out = runner(sql);
  return Array.isArray(out) ? out : [];
}

function scalar(runner, sql, col) {
  const r = rows(runner, sql);
  return r.length ? r[0][col] : null;
}

function tableExists(runner, name) {
  return (
    rows(runner, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${name}'`)
      .length > 0
  );
}

// 0) Non-empty corpus — UNCONDITIONAL hard guard. A catastrophic upstream failure (0 candidates) or
//    a botched derive can leave 0 contracts. On the served D1 the staging check self-skips (no
//    pipeline_stats) and every rollup sum is 0 == 0, so without this an empty database would pass the
//    whole gate green. Asserted on every backend so a silent empty ship cannot slip through.
export function checkNonEmptyCorpus(runner) {
  const name = 'non-empty-corpus';
  if (!tableExists(runner, 'contracts'))
    return { name, ok: true, skipped: true, detail: 'contracts table absent' };
  const n = num(scalar(runner, 'SELECT COUNT(*) AS n FROM contracts', 'n'));
  return {
    name,
    ok: n > 0,
    skipped: false,
    detail:
      n > 0
        ? `${n} contracts present`
        : 'EMPTY corpus: 0 contracts (catastrophic derive / upstream failure)',
  };
}

// 1) Rollup ↔ contracts reconciliation (the headline check). Each precompute rollup must sum to
//    exactly the clean contract value it attributes (mirroring precompute's own joins), and the
//    unattributed remainder must be exactly 0 rows. Requires precompute to have run; self-skips on
//    the pre-ship work DB, where normalize-raw has cleared the rollups and precompute runs later
//    on the served D1 (detected via the single home_totals row precompute always writes).
export function checkRollupReconciliation(runner) {
  const name = 'rollup-reconciliation';
  if (
    !tableExists(runner, 'home_totals') ||
    num(scalar(runner, 'SELECT COUNT(*) AS n FROM home_totals', 'n')) === 0
  ) {
    return {
      name,
      ok: true,
      skipped: true,
      detail: 'precompute rollups absent (home_totals empty)',
    };
  }

  // One combined query, not a dozen round-trips: on D1/wrangler each runner call is a process spawn,
  // so fold every reconciliation number into a single SELECT of scalar subqueries. The join clauses
  // mirror precompute's own rollups exactly (authority_totals = tenders→authorities; company_totals =
  // bidders AND tenders; flow_pairs = tenders→authorities AND bidders). authority_totals/company_totals
  // exclude synthetic 'неизвестна' orphan headers (is_synthetic != 1), so their attributed sums match;
  // flow_pairs + home_totals stay synthetic-inclusive and reconcile against inclusive sums. The two
  // orphan counts are the exact structural exclusions, asserted to be 0 (normalize gives every contract
  // a parent tender — synthetic if needed — with a non-null authority, and a bidder row).
  const r =
    rows(
      runner,
      'SELECT' +
        ' (SELECT COALESCE(SUM(amount_eur), 0) FROM contracts WHERE amount_eur IS NOT NULL) AS clean_total,' +
        ' (SELECT COALESCE(SUM(c.amount_eur), 0) FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id WHERE c.amount_eur IS NOT NULL AND c.is_synthetic != 1) AS auth_attr,' +
        ' (SELECT COALESCE(SUM(spent_eur), 0) FROM authority_totals) AS auth_rollup,' +
        ' (SELECT COALESCE(SUM(c.amount_eur), 0) FROM contracts c JOIN bidders b ON b.id = c.bidder_id JOIN tenders t ON t.id = c.tender_id WHERE c.amount_eur IS NOT NULL AND c.is_synthetic != 1) AS bidder_attr,' +
        ' (SELECT COALESCE(SUM(won_eur), 0) FROM company_totals) AS company_rollup,' +
        ' (SELECT COALESCE(SUM(c.amount_eur), 0) FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id WHERE c.amount_eur IS NOT NULL) AS flow_attr,' +
        ' (SELECT COALESCE(SUM(won_eur), 0) FROM flow_pairs) AS flow_rollup,' +
        ' (SELECT value_eur FROM home_totals) AS home_value,' +
        ' (SELECT COUNT(*) FROM contracts c WHERE c.amount_eur IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tenders t JOIN authorities a ON a.id = t.authority_id WHERE t.id = c.tender_id)) AS orphan_auth_rows,' +
        ' (SELECT COUNT(*) FROM contracts c WHERE c.amount_eur IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM bidders b WHERE b.id = c.bidder_id) OR NOT EXISTS (SELECT 1 FROM tenders t WHERE t.id = c.tender_id))) AS orphan_bidder_rows',
    )[0] || {};
  const cleanTotal = num(r.clean_total);
  const authAttr = num(r.auth_attr);
  const authRollup = num(r.auth_rollup);
  const bidderAttr = num(r.bidder_attr);
  const companyRollup = num(r.company_rollup);
  const flowAttr = num(r.flow_attr);
  const flowRollup = num(r.flow_rollup);
  const homeValue = num(r.home_value);
  const orphanAuthRows = num(r.orphan_auth_rows);
  const orphanBidderRows = num(r.orphan_bidder_rows);

  const fails = [];
  if (Math.abs(homeValue - cleanTotal) > EPS_EUR)
    fails.push(`home_totals.value_eur ${homeValue} != clean_total ${cleanTotal}`);
  if (Math.abs(authRollup - authAttr) > EPS_EUR)
    fails.push(`SUM(authority_totals.spent_eur) ${authRollup} != authority-attributed ${authAttr}`);
  if (Math.abs(companyRollup - bidderAttr) > EPS_EUR)
    fails.push(`SUM(company_totals.won_eur) ${companyRollup} != bidder-attributed ${bidderAttr}`);
  if (Math.abs(flowRollup - flowAttr) > EPS_EUR)
    fails.push(`SUM(flow_pairs.won_eur) ${flowRollup} != flow-attributed ${flowAttr}`);
  if (orphanAuthRows !== 0)
    fails.push(
      `${orphanAuthRows} clean contracts attribute to no authority (orphan tender/authority)`,
    );
  if (orphanBidderRows !== 0)
    fails.push(`${orphanBidderRows} clean contracts attribute to no bidder/tender`);
  // No separate clean_total vs authAttr value check: with orphanAuthRows === 0 every clean contract
  // joins an authority, so authAttr === clean_total identically — the orphan row count above already
  // proves it. (The home_value vs clean_total check covers the home rollup.)

  return {
    name,
    ok: fails.length === 0,
    skipped: false,
    detail: fails.length
      ? fails.join('; ')
      : `clean_total=${cleanTotal} reconciled across auth/company/flow/home`,
  };
}

// 2) No negative values feeding the totals. Two classes, split by who controls the defect:
//    - value_flag='ok' AND amount_eur<0 → HARD fail. A clean row cannot be negative except via a Sigma
//      derivation bug (e.g. a sign flip); Sigma owns and can fix it.
//    - any other flag with amount_eur<0 → WARN. normalize keeps value_low rows (set on
//      COALESCE(current,signing)<=0) with a populated, possibly negative amount_eur, and precompute
//      sums every amount_eur IS NOT NULL row regardless of flag — so a negative source value silently
//      understates a minister-visible total. The negative VALUE is upstream (#19–27) and Sigma cannot
//      correct the source, so this must not break the daily import; but it does corrupt the published
//      number, so it is surfaced loudly rather than hidden. (The accuracy-correct end state is to stop
//      summing negatives in the value basis — tracked as a follow-up; out of this gate's #97 scope.)
//    - no rollup total may be negative → HARD fail (a whole-group negative is structural corruption).
export function checkNoNegativeValues(runner) {
  const name = 'no-negative-values';
  if (!tableExists(runner, 'contracts'))
    return { name, ok: true, skipped: true, detail: 'contracts table absent' };
  const fails = [];
  const warns = [];
  // One read for both contract classes (ok-negative is a Sigma bug; non-ok-negative is upstream).
  const c =
    rows(
      runner,
      'SELECT' +
        " (SELECT COUNT(*) FROM contracts WHERE value_flag = 'ok' AND amount_eur < 0) AS neg_ok," +
        " (SELECT COUNT(*) FROM contracts WHERE value_flag <> 'ok' AND amount_eur < 0) AS neg_other",
    )[0] || {};
  const negOk = num(c.neg_ok);
  const negOther = num(c.neg_other);
  if (negOk !== 0) fails.push(`${negOk} contracts with value_flag='ok' have negative amount_eur`);
  if (negOther !== 0)
    warns.push(
      `${negOther} non-'ok' contract(s) carry a negative amount_eur still summed into the rollups ` +
        '(upstream value_low<=0, understates totals — #19–27, basis fix tracked)',
    );
  // The three rollups are created together by precompute, so one existence check gates all three, and
  // the three counts fold into a single SELECT (on D1 each runner call is a process spawn).
  if (tableExists(runner, 'home_totals')) {
    const r =
      rows(
        runner,
        'SELECT' +
          ' (SELECT COUNT(*) FROM authority_totals WHERE spent_eur < 0) AS a,' +
          ' (SELECT COUNT(*) FROM company_totals WHERE won_eur < 0) AS c,' +
          ' (SELECT COUNT(*) FROM flow_pairs WHERE won_eur < 0) AS f',
      )[0] || {};
    if (num(r.a) !== 0) fails.push(`${num(r.a)} authority_totals.spent_eur rows are negative`);
    if (num(r.c) !== 0) fails.push(`${num(r.c)} company_totals.won_eur rows are negative`);
    if (num(r.f) !== 0) fails.push(`${num(r.f)} flow_pairs.won_eur rows are negative`);
  }
  const ok = fails.length === 0;
  return {
    name,
    ok,
    skipped: false,
    warn: ok && warns.length > 0,
    detail: [...fails, ...warns].join('; ') || 'no negative clean values',
  };
}

// 3) EIK validity (canonical home: bidders). eik_valid=1 ⇒ eik_normalized is a numeric 9/13-digit
//    ЕИК; eik_valid<>1 ⇒ eik_normalized IS NULL. normalize-raw guarantees this (it sets
//    eik_normalized only when eik_valid=1); the gate proves the guarantee held.
export function checkEikValidity(runner) {
  const name = 'eik-validity';
  if (!tableExists(runner, 'bidders'))
    return { name, ok: true, skipped: true, detail: 'bidders table absent' };
  const fails = [];
  const badValid = num(
    scalar(
      runner,
      'SELECT COUNT(*) AS n FROM bidders WHERE eik_valid = 1 AND (' +
        "eik_normalized IS NULL OR eik_normalized GLOB '*[^0-9]*' OR LENGTH(eik_normalized) NOT IN (9, 13))",
      'n',
    ),
  );
  if (badValid !== 0)
    fails.push(
      `${badValid} bidders with eik_valid=1 have a non-numeric / wrong-length eik_normalized`,
    );
  const badInvalid = num(
    scalar(
      runner,
      'SELECT COUNT(*) AS n FROM bidders WHERE eik_valid <> 1 AND eik_normalized IS NOT NULL',
      'n',
    ),
  );
  if (badInvalid !== 0)
    fails.push(`${badInvalid} bidders with eik_valid<>1 carry a non-null eik_normalized`);
  return {
    name,
    ok: fails.length === 0,
    skipped: false,
    detail: fails.length ? fails.join('; ') : 'EIK validity consistent on bidders',
  };
}

// 4) Date sanity — REPORTED, NOT GATED. Unlike the other checks, signed_at is a pass-through of the
//    upstream EOP value, not something Sigma derives. An out-of-range date is an upstream record-level
//    defect (#19–27) that Sigma consumes and cannot correct, so it must NEVER break the daily import —
//    a single source typo (real example: signed_at='2029-05-14' in the 2024 feed) would otherwise fail
//    every refresh forever. We surface the count as a WARN (a spike would flag a Sigma-side date-parse
//    regression for a human to notice) but always return ok. NULL is allowed.
export function checkDateSanity(runner) {
  const name = 'date-sanity';
  if (!tableExists(runner, 'contracts'))
    return { name, ok: true, skipped: true, detail: 'contracts table absent' };
  const n = num(
    scalar(
      runner,
      'SELECT COUNT(*) AS n FROM contracts WHERE signed_at IS NOT NULL AND ' +
        "(signed_at < '2007-01-01' OR signed_at > date('now'))",
      'n',
    ),
  );
  return {
    name,
    ok: true,
    skipped: false,
    warn: n > 0,
    detail:
      n === 0
        ? 'all non-null signed_at in [2007-01-01, today]'
        : `${n} contract(s) have signed_at outside [2007-01-01, today] — upstream record-level defect (#19–27), reported not gated`,
  };
}

// 5) Staging → domain reconciliation. normalize-raw records, in one row of pipeline_stats, the
//    eligible-candidate count (the SAME expression the summary prints) and the resulting contracts
//    count. The gate asserts no contract appeared without an eligible candidate (inserted ≤
//    candidates — corroborates the orphan check from the staging side) and that a non-empty corpus
//    actually landed. The candidates−inserted gap is the cumulative-bucket dedup drop (≥0, reported).
//    Self-skips where pipeline_stats is absent (served D1) or stale (slice path changed the count).
export function checkStagingReconciliation(runner) {
  const name = 'staging-reconciliation';
  if (!tableExists(runner, 'pipeline_stats'))
    return {
      name,
      ok: true,
      skipped: true,
      detail: 'pipeline_stats absent (not a post-normalize DB)',
    };
  const row = rows(
    runner,
    'SELECT contract_candidates, contracts_inserted, computed_at FROM pipeline_stats WHERE id = 1',
  )[0];
  if (!row) return { name, ok: true, skipped: true, detail: 'pipeline_stats empty' };
  const candidates = num(row.contract_candidates);
  const recorded = num(row.contracts_inserted);
  const computedAt = row.computed_at ?? 'unknown';
  const current = num(scalar(runner, 'SELECT COUNT(*) AS n FROM contracts', 'n'));
  if (recorded !== current)
    return {
      name,
      ok: true,
      skipped: true,
      detail: `pipeline_stats stale (recorded ${recorded} at ${computedAt} != current contracts ${current}); recon runs only right after a full normalize`,
    };

  const fails = [];
  if (current > candidates)
    fails.push(
      `inserted contracts ${current} exceed eligible candidates ${candidates} (orphan bidder/tender or eligibility regression)`,
    );
  if (candidates > 0 && current === 0)
    fails.push(`${candidates} eligible candidates but 0 contracts inserted`);
  return {
    name,
    ok: fails.length === 0,
    skipped: false,
    detail: fails.length
      ? fails.join('; ')
      : `candidates=${candidates} inserted=${current} dedup_drop=${candidates - current} (computed ${computedAt})`,
  };
}

export const CHECKS = [
  checkNonEmptyCorpus,
  checkRollupReconciliation,
  checkNoNegativeValues,
  checkEikValidity,
  checkDateSanity,
  checkStagingReconciliation,
];

export function runIntegrityChecks(runner) {
  return CHECKS.map((fn) => fn(runner));
}

// Run all checks, print a one-line summary per check, and FAIL non-zero on any real violation.
// `exit: true` (default) mirrors assertFxPopulated — print to stderr and process.exit(1). Tests pass
// `exit: false` to get a thrown Error instead (the assertion still fails the same way).
export function assertIntegrity(runner, { label = 'integrity', exit = true } = {}) {
  const results = runIntegrityChecks(runner);
  let failed = 0;
  for (const r of results) {
    const tag = r.skipped ? 'SKIP' : r.warn ? 'WARN' : r.ok ? ' ok ' : 'FAIL';
    console.log(`   [${tag}] ${r.name}: ${r.detail}`);
    if (!r.skipped && !r.ok) failed += 1;
  }
  if (failed > 0) {
    const msg = `!! integrity gate failed: ${failed} of ${results.length} checks broke (${label}).`;
    console.error(msg);
    if (exit) process.exit(1);
    throw new Error(msg);
  }
  const ran = results.filter((r) => !r.skipped).length;
  const skipped = results.length - ran;
  const warned = results.filter((r) => r.warn).length;
  console.log(
    `==> integrity gate passed (${ran} run, ${skipped} skipped${warned ? `, ${warned} warned` : ''}).`,
  );
  return results;
}
