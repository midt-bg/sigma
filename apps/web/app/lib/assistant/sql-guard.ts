// run_sql safety — read-only enforcement (spec §7, hardened by §9 point 4).
//
// LAYERED DEFENCE — this module is the CHEAP, deploy-independent first layer. What it adds: strip
// comments, reject stacked statements, require a leading SELECT/WITH, keyword blocklist, and a hard
// injected LIMIT + result byte cap. Fails closed.
//
// Blocklists are bypassable in principle (casing/comments/stacking), so run_sql also runs the
// stronger AST guard in sql-ast-guard.ts (node-sql-parser, SQLite grammar) — it parses the statement
// and FAILS CLOSED unless it is a single read-only SELECT. The remaining belt-and-braces layer (still
// open, tracked in the README roadmap) is a read-only data path: the binding handed to run_sql must
// not have write rights to the served D1 (spec §9.4) — `env.DB` is read-write today, so a parser miss
// would be UPDATE/DELETE on production, not a "weird report".

export const MAX_ROWS = 500;
export const RESULT_BYTE_CAP = 64 * 1024; // bytes of JSON returned to the model (spec §7)

// `REPLACE` is intentionally absent: it would also reject the safe, common scalar string function
// `REPLACE(col, a, b)` (e.g. normalising Cyrillic↔Latin look-alikes). The write form `REPLACE INTO` is
// already blocked by the leading-token check (only SELECT/WITH may lead) and, inside a CTE, by the AST
// guard's statement-type/parse check — so dropping it from this list loses no coverage (review #80).
const FORBIDDEN = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'UPSERT',
  'MERGE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'RENAME',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'VACUUM',
  'REINDEX',
  'ANALYZE',
  'TRIGGER',
  'GRANT',
  'REVOKE',
];

// Strip `/* block */` and `-- line` comments, but NOT when they fall inside a single-quoted string
// literal — a regex pass that ignored literals silently corrupted query semantics: `name = 'a/*b*/c'`
// became `name = 'a c'` (wrong rows), and `'x -- y'` was truncated to an unterminated string (fail-closed
// false-deny). The executed SQL is this stripped string, so the corruption is invisible. Mirror the
// literal/`''`-escape handling of splitStatements below so both layers model strings the same way
// (review #80, follow-up). A `--`/`/*` inside a literal is preserved as data.
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  let inString = false;
  while (i < n) {
    const ch = sql[i]!;
    if (inString) {
      if (ch === "'" && sql[i + 1] === "'") {
        out += "''"; // escaped quote inside a literal — consume both, stay in the string
        i += 2;
        continue;
      }
      out += ch;
      if (ch === "'") inString = false;
      i++;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++; // to end of line (the newline is kept, handled next loop)
      out += ' ';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2; // skip the closing */ (overshooting n is harmless)
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Split on `;` at the top level, treating a `;` inside a single-quoted string literal as data, not a
// statement separator — otherwise a benign `SELECT ';' …` is mis-counted as stacked statements and
// rejected (review #80). SQLite escapes a quote inside a literal by doubling it (`'a''b'` is the value
// `a'b`), so a `''` pair is consumed as data and does NOT toggle the string — a plain toggle on every
// `'` mis-models the literal (review #80). A real stacked statement still splits; an unbalanced quote
// just yields one segment (the AST guard then fails to parse it).
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'" && inString && sql[i + 1] === "'") {
      // Escaped quote inside a literal: consume both chars and stay in the string.
      current += "''";
      i++;
    } else if (ch === "'") {
      inString = !inString;
      current += ch;
    } else if (ch === ';' && !inString) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

/** Structural read-only check. Returns the de-commented, single-statement SQL or a rejection. */
export function assertReadOnlySelect(rawSql: string): GuardResult {
  const stripped = stripComments(rawSql).trim();
  if (!stripped) return { ok: false, reason: 'empty query' };

  // Reject stacked statements: at most one trailing `;` (ignoring `;` inside string literals).
  const statements = splitStatements(stripped);
  if (statements.length !== 1) {
    return { ok: false, reason: 'only a single statement is allowed' };
  }
  const sql = statements[0]!;

  if (!/^(select|with)\b/i.test(sql)) {
    return { ok: false, reason: 'query must start with SELECT or WITH' };
  }

  // Whole-word keyword blocklist (cheap second layer; the AST parser is the real guard).
  for (const kw of FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(sql)) {
      return { ok: false, reason: `forbidden keyword: ${kw}` };
    }
  }

  // `\bPRAGMA\b` above does NOT catch the table-valued *function* form `pragma_table_info(...)` (the
  // `_` is a word char, so there is no boundary). Block the `pragma_*` identifiers here too — the AST
  // guard rejects all table-valued functions, this is the cheap belt-and-braces layer (review #80).
  if (/\bpragma_\w+/i.test(sql)) {
    return { ok: false, reason: 'pragma functions are not allowed' };
  }

  // Common table-valued functions are invisible to the AST allowlist (parser.tableList() returns []
  // for them), so they are the same blind spot as pragma_*. The AST guard rejects every TVF in a FROM
  // at any depth; this is the cheap first-layer catch for the well-known ones (review #80, ydimitrof H1).
  if (/\b(?:json_each|json_tree|generate_series)\s*\(/i.test(sql)) {
    return { ok: false, reason: 'table-valued functions are not allowed' };
  }

  // Schema-catalog tables are the crown-jewel enumeration target. The AST guard now scopes CTE names
  // lexically (so an out-of-scope `sqlite_master` CTE can't exempt the real table), but keep a cheap
  // structural backstop on the two catalog names too — no legitimate query references them (review #80).
  if (/\bsqlite_(?:master|schema)\b/i.test(sql)) {
    return { ok: false, reason: 'system catalog tables are not allowed' };
  }

  // Dangerous SCALAR functions the table-allowlist / TVF guards don't see (they sit in the SELECT list,
  // not a FROM source): `load_extension` loads a dynamic library (RCE where SQLite enables it — D1
  // disables it, but block defensively); `randomblob`/`zeroblob` build arbitrarily large blobs; and
  // `printf`/`format` with a width specifier (`printf('%1000000d', x)`) build arbitrarily large STRINGS.
  // All materialise in Worker memory before capRows can measure the row — a single row can OOM the
  // isolate. No analytics query needs any of them (review #80, red-team R2; printf/format f/u).
  if (/\b(?:load_extension|randomblob|zeroblob|printf|format)\s*\(/i.test(sql)) {
    return { ok: false, reason: 'function not allowed' };
  }
  return { ok: true, sql };
}

/** Inject a LIMIT when absent; clamp it when above `max`. Operates on a guarded single statement. */
export function enforceLimit(sql: string, max = MAX_ROWS): string {
  const m = sql.match(/\blimit\s+(\d+)\b(?![\s\S]*\blimit\b)/i);
  if (!m) return `${sql.replace(/;?\s*$/, '')} LIMIT ${max}`;
  const n = Number(m[1]);
  if (n <= max) return sql;
  return sql.slice(0, m.index) + `LIMIT ${max}` + sql.slice(m.index! + m[0].length);
}

/**
 * Cap the JSON the model sees (spec §7): keep appending rows while under the byte budget, and flag
 * truncation so the report callout can say "results truncated". Pure — the caller supplies rows.
 */
export function capRows(
  rows: (string | number | null)[][],
  cap = RESULT_BYTE_CAP,
): { rows: (string | number | null)[][]; truncated: boolean } {
  const out: (string | number | null)[][] = [];
  const enc = new TextEncoder(); // hoisted: one encoder for the whole result, not one per row (≤500)
  let bytes = 2; // []
  for (const row of rows) {
    const size = enc.encode(JSON.stringify(row)).length + 1;
    if (bytes + size > cap) {
      // Keep at least the first row even if it alone exceeds the cap: otherwise a successful query whose
      // first row is huge yields rows:[], and a model `row:0` ref then errors "out of range (0..-1)" on
      // a query that actually worked. Flag truncation either way (review #80).
      if (out.length === 0) out.push(row);
      return { rows: out, truncated: true };
    }
    out.push(row);
    bytes += size;
  }
  return { rows: out, truncated: false };
}
