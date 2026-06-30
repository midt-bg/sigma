// Adversarial / parser-differential suite for the two-layer run_sql guard (spec §7, §9.4).
//
// This file PROVES the two guards compose and FAIL CLOSED, and DOCUMENTS the known read-only gaps. It
// is deliberately GREEN against the CURRENT code: every assertion encodes the OBSERVED behaviour, not
// aspirational behaviour. Where a query the guards SHOULD reject actually passes (a discovered gap) the
// test asserts the real `ok:true` and marks it `// VULN(...)` / `// GAP(...)` so the gap is tracked and
// any future tightening that closes it makes the test fail (forcing a conscious update).
//
// Composition mirrors production run_sql: Layer 1 (`assertReadOnlySelect`, structural / comment-strip /
// blocklist) runs first; Layer 2 (`guardSelect`, node-sql-parser AST allowlist) parses Layer 1's
// comment-stripped OUTPUT. `run()` returns which layer rejected so the suite is parser-differential:
// it records WHERE each case dies, not merely that it does. For genuinely parser-dependent cases the
// security-relevant fact (`ok === false`) is asserted AND the observed layer is pinned, so a parser
// bump that relocates the rejection fails this test rather than silently weakening coverage.
//
// SECURITY SUMMARY:
//   - No WRITE / non-SELECT statement reaches `ok:true` here — the two layers fail closed on every
//     write/DDL/stacked/TVF/recursion/cross-join vector exercised below.
//   - CLOSED (was a read-only gap): scalar exfiltration (group_concat/quote/hex) and dangerous scalar
//     functions re-reached by DOUBLE-QUOTING the name (`"randomblob"(…)`, `"load_extension"(…)`,
//     `"printf"('%1000000d',…)`) — these slip Layer-1's `\bfn\s*\(` blocklist (the `"` breaks the
//     boundary) but are now rejected by Layer 2's AST name blocklist (`denyDangerousFunction` in
//     sql-ast-guard.ts), which normalises `fn` and `"fn"` to the same name. Sections B and G assert the
//     rejection (at Layer 2) rather than the former pass.

import { describe, expect, it } from 'vitest';
import { assertReadOnlySelect } from './sql-guard';
import { guardSelect } from './sql-ast-guard';

// Compose the two layers exactly as run_sql does, and report which layer rejected (parser-differential).
function run(sql: string): { ok: boolean; layer: 1 | 2 | null; reason?: string } {
  const l1 = assertReadOnlySelect(sql);
  if (!l1.ok) return { ok: false, layer: 1, reason: l1.reason };
  const l2 = guardSelect(l1.sql);
  if (!l2.ok) return { ok: false, layer: 2, reason: l2.reason };
  return { ok: true, layer: null };
}

// Assert a query is rejected, pinning the OBSERVED layer (so a parser bump that moves the rejection
// trips the test) and, when stable, the reason text.
function expectReject(sql: string, layer: 1 | 2, reason?: RegExp): void {
  const r = run(sql);
  expect(r.ok, sql).toBe(false);
  expect(r.layer, sql).toBe(layer);
  if (reason && r.reason) expect(r.reason, sql).toMatch(reason);
}

const NBSP = '\u00A0'; // non-breaking space — NOT whitespace to node-sql-parser

describe('sql-guard adversarial / parser-differential', () => {
  describe('A. FTS5 MATCH (read-only but parser-false-denied)', () => {
    it('rejects FTS MATCH at Layer 2 — read-only, yet node-sql-parser cannot parse it (false-deny)', () => {
      // search_index is allowlisted, so this is a legitimate read; the SQLite build of node-sql-parser
      // does not understand the `MATCH` operator, so it fails closed at parse. DATA_TRAPS already steers
      // the model to semantic_search instead. Documented as a usability cost of failing closed.
      expectReject(
        "SELECT title FROM search_index WHERE search_index MATCH 'sofia'",
        2,
        /could not be parsed/,
      );
    });
  });

  describe('B. scalar exfiltration is blocked at Layer 2 (closed read-only gap)', () => {
    // The Layer-1 scalar blocklist never covered group_concat/quote/hex (column concat/encoding into one
    // cell). Layer 2's AST name blocklist (denyDangerousFunction) now rejects them — closing the gap.
    it('rejects group_concat at Layer 2 — column concatenation', () => {
      const r = run('SELECT group_concat(name) AS n FROM authorities');
      expect(r.ok).toBe(false);
      expect(r.layer).toBe(2);
      if (!r.ok) expect(r.reason).toMatch(/function not allowed/i);
    });
    it('rejects quote() at Layer 2 — SQL-literal encoding of a column', () => {
      const r = run('SELECT quote(name) AS n FROM authorities');
      expect(r.ok).toBe(false);
      expect(r.layer).toBe(2);
    });
    it('rejects hex() at Layer 2 — even on a realistic contracts query', () => {
      const r = run('SELECT hex(name) AS n FROM contracts WHERE amount_eur IS NOT NULL');
      expect(r.ok).toBe(false);
      expect(r.layer).toBe(2);
    });
  });

  describe('C. system-catalog enumeration', () => {
    it('rejects bare sqlite_master at Layer 1 (cheap structural backstop)', () => {
      expectReject('SELECT name, sql FROM sqlite_master', 1, /system catalog/);
    });
    it('rejects sqlite_sequence / sqlite_stat1 at Layer 2 (L1 regex covers ONLY master|schema)', () => {
      // GAP-documented: the Layer-1 `\bsqlite_(master|schema)\b` regex deliberately misses the other
      // sqlite_* catalog tables; the positive AST allowlist is what actually rejects them.
      expectReject('SELECT * FROM sqlite_sequence', 2, /table not allowed: sqlite_sequence/);
      expectReject('SELECT tbl FROM sqlite_stat1', 2, /table not allowed: sqlite_stat1/);
    });
    it('rejects quoted / bracketed / backtick sqlite_master — at Layer 1 (regex matches through quoting)', () => {
      // Parser-differential: observed to die at Layer 1 because its name regex matches inside the quote
      // characters (they are non-word, so the \b boundaries still hold). Pinned so a change is noticed.
      expectReject('SELECT name FROM "sqlite_master"', 1, /system catalog/);
      expectReject('SELECT name FROM [sqlite_master]', 1, /system catalog/);
      expectReject('SELECT name FROM `sqlite_master`', 1, /system catalog/);
    });
  });

  describe('D. CTE recursion / scope', () => {
    it('rejects WITH RECURSIVE at Layer 2 (keyword guard, post comment-strip)', () => {
      expectReject(
        'WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT x FROM r',
        2,
        /recursive queries are not allowed/,
      );
    });
    it('rejects implicit recursion (no RECURSIVE keyword) at Layer 2 via the self-reference walk', () => {
      expectReject(
        'WITH r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT x FROM r',
        2,
        /recursive CTE "r" is not allowed/,
      );
    });
    it('passes a CTE whose name coincides with an ALLOWLISTED table — uninformative (name resolves to the real table)', () => {
      // The outer `FROM authorities` resolves to the real allowlisted table regardless of the unrelated
      // inner CTE, so this passes. It is NOT a bypass — `authorities` is allowed either way. (The
      // dangerous mirror — a CTE named like a DISALLOWED table — is covered in sql-ast-guard.test.ts.)
      expect(
        run(
          'WITH dummy AS (WITH authorities AS (SELECT 1 AS k) SELECT 1 AS k) SELECT name FROM authorities',
        ).ok,
      ).toBe(true);
    });
  });

  describe('E. compound-arm enumeration past the L1 master-only regex', () => {
    it('rejects UNION into sqlite_stat1 at Layer 2 (forces the allowlist; L1 regex misses stat1)', () => {
      expectReject(
        'SELECT name FROM authorities UNION SELECT tbl FROM sqlite_stat1',
        2,
        /table not allowed: sqlite_stat1/,
      );
    });
    it('rejects INTERSECT / EXCEPT compounds at Layer 2 — node-sql-parser (sqlite) cannot parse them', () => {
      // Parser-differential: the SQLite build does not implement INTERSECT/EXCEPT, so these die at parse
      // rather than at the allowlist. Still fail-closed; pinned so a grammar upgrade is noticed.
      expectReject(
        'SELECT name FROM authorities INTERSECT SELECT tbl FROM sqlite_stat1',
        2,
        /could not be parsed/,
      );
      expectReject(
        'SELECT name FROM authorities EXCEPT SELECT tbl FROM sqlite_stat1',
        2,
        /could not be parsed/,
      );
    });
  });

  describe('F. comment-strip divergence (Layer 2 parses Layer 1 OUTPUT)', () => {
    it('accepts a stacked DROP hidden ENTIRELY inside a block comment (L1 strips it; L2 parses bare SELECT 1)', () => {
      expect(run('SELECT 1 /* ; DROP TABLE contracts */').ok).toBe(true);
    });
    it('rejects an intra-keyword comment `SE/**/LECT 1` at Layer 1 (strip yields leading token "SE")', () => {
      // The comment is replaced by a space BEFORE the leading-token check, so the statement no longer
      // starts with SELECT/WITH. Parser-differential result: dies at Layer 1, not the parser.
      expectReject('SE/**/LECT 1', 1, /start with SELECT or WITH/);
    });
    it('rejects a real stacked statement after a quoted-semicolon literal at Layer 1 (single-statement)', () => {
      expectReject(
        "SELECT ';' AS n FROM contracts WHERE amount_eur IS NOT NULL; DROP TABLE contracts",
        1,
        /single statement/,
      );
    });
    it('accepts an escaped-quote literal containing a semicolon (no stacked statement)', () => {
      // `'a''b; c'` is the single value "a'b; c"; the doubled-quote escape keeps the ; as data.
      expect(run("SELECT 'a''b; c' AS n").ok).toBe(true);
    });
  });

  describe('G. keyword / identifier evasion', () => {
    it('accepts a TAB between keywords (the parser treats it as whitespace)', () => {
      expect(run('SELECT\t1').ok).toBe(true);
    });
    it('rejects a NON-BREAKING SPACE between keywords at Layer 2 (parser rejects; L1 \\b passes it)', () => {
      // U+00A0 is not whitespace to node-sql-parser, so a read-only query is false-denied at parse —
      // the same fail-closed cost as the FTS MATCH case. L1's leading-token \b boundary lets it through.
      expectReject(`SELECT${NBSP}1`, 2, /could not be parsed/);
      expectReject(`SELECT${NBSP}name FROM authorities`, 2, /could not be parsed/);
    });
    it('accepts mixed-case `sElEcT 1` (keyword matching is case-insensitive)', () => {
      expect(run('sElEcT 1').ok).toBe(true);
    });
    it('rejects `printf (...)` with a space before the paren at Layer 1 (the \\s* in the blocklist)', () => {
      expectReject("SELECT printf ('%9d', 1)", 1, /function not allowed/);
    });
    it('rejects double-quoted dangerous function names at Layer 2 (closed scalar-bomb-evasion gap)', () => {
      // The Layer-1 regex is `\b(load_extension|randomblob|zeroblob|printf|format)\s*\(` — the `"` between
      // the name and `(` breaks the `\b`, so the L1 text blocklist misses `"randomblob"(…)`. SQLite still
      // resolves the double-quoted identifier as the function (memory-amplification DoW, or load_extension
      // RCE where enabled). Layer 2's AST name blocklist normalises `fn` and `"fn"` to the same name and
      // rejects both — so the quoting bypass is now closed at L2.
      for (const sql of [
        'SELECT "printf"(\'%1000000d\', 1) AS n',
        'SELECT "randomblob"(1000000000) AS n',
        'SELECT "load_extension"(\'evil\') AS n',
        'SELECT "group_concat"(name) AS n FROM authorities',
      ]) {
        const r = run(sql);
        expect(r.ok, sql).toBe(false);
        expect(r.layer, sql).toBe(2);
        if (!r.ok) expect(r.reason, sql).toMatch(/function not allowed/i);
      }
    });
  });

  describe('H. LIMIT abuse', () => {
    it('rejects the LIMIT offset, count comma form at Layer 2 (fools the regex enforceLimit)', () => {
      expectReject('SELECT name FROM authorities LIMIT 5, 10000', 2, /LIMIT offset, count/);
    });
    it('rejects LIMIT -1 (unbounded in SQLite) at Layer 2', () => {
      expectReject('SELECT name FROM authorities LIMIT -1', 2, /negative LIMIT/);
    });
    it('rejects non-integer LIMIT literals (1e9, 1.5) the regex cannot clamp, at Layer 2', () => {
      expectReject('SELECT name FROM authorities LIMIT 1e9', 2, /integer/);
      expectReject('SELECT name FROM authorities LIMIT 1.5', 2, /integer/);
    });
    it('ACCEPTS an oversized plain integer LIMIT — clamped, not rejected', () => {
      expect(run('SELECT name FROM authorities LIMIT 100000').ok).toBe(true);
    });
  });

  describe('I. EXPLAIN as user input', () => {
    it('rejects EXPLAIN and EXPLAIN QUERY PLAN at Layer 1 (leading-token gate)', () => {
      expectReject('EXPLAIN SELECT 1', 1, /start with SELECT or WITH/);
      expectReject('EXPLAIN QUERY PLAN SELECT 1', 1, /start with SELECT or WITH/);
    });
  });
});
