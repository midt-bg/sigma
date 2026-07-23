// Read-only SQL predicate for the @sigma/db read-only D1 wrapper (issue #199). Answers one question —
// "would this statement write?" — so the wrapper can gate env.DB.prepare/exec and the web runtime can
// never mutate D1, even if the assistant run_sql AST guard is bypassed. The check is TEXT-based and
// quote-aware: it tracks all four SQLite quoted regions — '…' string, "…"/`…`/[…] identifiers — so a
// write verb inside any of them is data, and a quote inside an identifier cannot open a phantom string
// that hides a following write (the #225 review bypass). Why not an AST parse here: the loader queries
// are dynamically assembled and node-sql-parser fail-closes on valid SQLite it cannot parse, so parsing
// would reject real reads and 500 a live loader. node-sql-parser stays on the assistant run_sql path only.

// Statement-level write verbs, matched whole-word OUTSIDE any quoted region. REPLACE is intentionally
// absent — it collides with the read-only scalar replace(); its write form `REPLACE INTO` is matched
// separately, and a leading REPLACE is already rejected by the SELECT/WITH/EXPLAIN allow-list.
// Deliberately broad: some entries aren't standalone SQLite statements (MERGE/UPSERT/GRANT/REVOKE/
// TRUNCATE, and RENAME/TRIGGER which only occur inside ALTER/CREATE) — kept as forward-proofing. The
// cost is a theoretical false-reject if a *column/alias* is named after one (e.g. `SELECT trigger …`);
// the read-loader corpus test rules that out for every real query, so it stays a non-issue in practice.
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

// SQLite quoted regions and their closing delimiter. '…'/"…"/`…` escape the delimiter by doubling it
// (`''`, `""`, `` `` ``); […] has no escape and ends at the first `]`. Tracking all four — not just `'…'`
// — is what closes the identifier-quote bypass (#225): a `'` inside `"x'"` is an identifier char, not a
// string open, so it can't hide a following write.
const QUOTE_CLOSE: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };

function isQuoteOpen(ch: string): boolean {
  return ch === "'" || ch === '"' || ch === '`' || ch === '[';
}

// Strip `-- line` and `/* block */` comments, but treat a comment marker inside any quoted region as
// data (a `--`/`/*` inside a string or identifier is preserved).
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  let quote: string | null = null; // open delimiter of the current quoted region, or null
  while (i < n) {
    const ch = sql[i]!;
    if (quote) {
      const close = QUOTE_CLOSE[quote]!;
      if (ch === close && quote !== '[' && sql[i + 1] === close) {
        out += ch + close; // doubled delimiter is an escape, not a close
        i += 2;
        continue;
      }
      out += ch;
      if (ch === close) quote = null;
      i++;
      continue;
    }
    if (isQuoteOpen(ch)) {
      quote = ch;
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

// Split on top-level `;`, treating a `;` inside any quoted region as data, so a benign `SELECT ';'` or a
// `;` inside a "…" identifier is not mis-counted as a stacked statement.
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      const close = QUOTE_CLOSE[quote]!;
      if (ch === close && quote !== '[' && sql[i + 1] === close) {
        current += ch + close;
        i++;
        continue;
      }
      current += ch;
      if (ch === close) quote = null;
      continue;
    }
    if (isQuoteOpen(ch)) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Blank the contents of every quoted region (string OR identifier), keeping a boundary space, so a write
// verb used as data — `WHERE status = 'CREATE'`, a `"DELETE"` column identifier — cannot trip the
// write-verb blocklist, and a quote inside an identifier cannot hide a following write.
function stripQuoted(sql: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      const close = QUOTE_CLOSE[quote]!;
      if (ch === close && quote !== '[' && sql[i + 1] === close) {
        i++; // doubled-delimiter escape — drop both, stay in the region
        continue;
      }
      if (ch === close) {
        quote = null;
        out += ' '; // closing delimiter → boundary space
        continue;
      }
      continue; // drop the region's content
    }
    if (isQuoteOpen(ch)) {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * True when `rawSql` is a single read-only statement safe to run on a read-only D1 handle. Rejects
 * stacked statements, anything not leading with SELECT/WITH/EXPLAIN, and any statement-level write verb
 * (incl. CTE-prefixed DML like `WITH … DELETE`) found outside a quoted region.
 */
export function isReadOnlySql(rawSql: string): boolean {
  const stripped = stripComments(rawSql).trim();
  if (!stripped) return false;
  const statements = splitStatements(stripped);
  if (statements.length !== 1) return false;
  const stmt = statements[0]!;
  if (!LEADING_READ_RE.test(stmt)) return false;
  const code = stripQuoted(stmt);
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
