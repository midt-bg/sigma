// Read-only SQL predicate for the @sigma/db read-only D1 wrapper (issue #199). Answers one question —
// "would this statement write?" — so the wrapper can gate env.DB.prepare/exec and the web runtime can
// never mutate D1, even if the assistant run_sql AST guard is bypassed. The check is TEXT-based and
// literal-aware (a write verb inside a '…' literal is data, not a write). Why not an AST parse here: the
// loader queries are dynamically assembled and node-sql-parser fail-closes on valid SQLite it cannot
// parse, so parsing would reject real reads and 500 a live loader. node-sql-parser stays on the
// assistant run_sql path only. The comment/literal handling mirrors apps/web assistant sql-guard.ts so
// both layers model strings identically.

// Statement-level write verbs, matched whole-word OUTSIDE string literals. REPLACE is intentionally
// absent — it collides with the read-only scalar replace(); its write form `REPLACE INTO` is matched
// separately, and a leading REPLACE is already rejected by the SELECT/WITH/EXPLAIN allow-list.
const WRITE_VERBS = [
  'INSERT',
  'UPDATE',
  'DELETE',
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
  'UPSERT',
  'MERGE',
  'GRANT',
  'REVOKE',
];
const WRITE_VERB_RE = new RegExp(`\\b(?:${WRITE_VERBS.join('|')})\\b`, 'i');
const REPLACE_INTO_RE = /\breplace\s+into\b/i;
// Side-effect / code-loading functions that carry no write verb, so the blocklist above misses them.
// Not reachable on Cloudflare D1 (extension loading disabled, no fts3 tokenizer-pointer API) and no
// loader uses them — rejected here for defense-in-depth.
const DANGEROUS_FN_RE = /\b(?:load_extension|writefile|readfile|fts3_tokenizer)\s*\(/i;
const LEADING_READ_RE = /^(?:select|with|explain)\b/i;

// Strip `-- line` and `/* block */` comments, but treat a comment marker inside a '…' literal as data
// (a `--`/`/*` in a literal is preserved). Mirrors sql-guard.ts; `''` is an escaped quote, not a close.
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  let inString = false;
  while (i < n) {
    const ch = sql[i]!;
    if (inString) {
      if (ch === "'" && sql[i + 1] === "'") {
        out += "''";
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
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Split on top-level `;`, treating a `;` inside a '…' literal (with `''` escapes) as data, so a benign
// `SELECT ';'` is not mis-counted as stacked. Mirrors sql-guard.ts.
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'" && inString && sql[i + 1] === "'") {
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

// Blank the contents of every '…' literal (keeping a boundary space) so a write verb used as data —
// `WHERE status = 'CREATE'`, `'DEL' || 'ETE'` — cannot trip the whole-word write-verb blocklist.
function stripStringLiterals(sql: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inString) {
      if (ch === "'" && sql[i + 1] === "'") {
        i++;
        continue;
      }
      if (ch === "'") {
        inString = false;
        out += ' ';
        continue;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * True when `rawSql` is a single read-only statement safe to run on a read-only D1 handle. Rejects
 * stacked statements, anything not leading with SELECT/WITH/EXPLAIN, and any statement-level write verb
 * (incl. CTE-prefixed DML like `WITH … DELETE`) found outside a string literal.
 */
export function isReadOnlySql(rawSql: string): boolean {
  const stripped = stripComments(rawSql).trim();
  if (!stripped) return false;
  const statements = splitStatements(stripped);
  if (statements.length !== 1) return false;
  const stmt = statements[0]!;
  if (!LEADING_READ_RE.test(stmt)) return false;
  const code = stripStringLiterals(stmt);
  return !WRITE_VERB_RE.test(code) && !REPLACE_INTO_RE.test(code) && !DANGEROUS_FN_RE.test(code);
}

/** Throw unless `rawSql` is read-only. The error message contains "read-only" for the wrapper's tests. */
export function assertReadOnly(rawSql: string): void {
  if (isReadOnlySql(rawSql)) return;
  const preview = rawSql.trim().replace(/\s+/g, ' ').slice(0, 80);
  throw new Error(
    `@sigma/db: refusing a non-read-only statement on the read-only D1 handle: ${preview}`,
  );
}

/**
 * Assert EVERY statement in a (possibly multi-statement) `.exec()` string is read-only. `.exec()` runs
 * more than one statement, so a first-statement-only check would miss `SELECT 1; DELETE …`.
 */
export function assertReadOnlyExec(rawSql: string): void {
  const statements = splitStatements(stripComments(rawSql));
  if (statements.length === 0) {
    throw new Error('@sigma/db: refusing an empty statement on the read-only D1 handle');
  }
  for (const stmt of statements) assertReadOnly(stmt);
}
