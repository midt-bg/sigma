const FORMULA_PREFIX = /^(?:[ \t\r\n]*[=+\-@]|[\t\r\n])/;
const QUOTE_TRIGGER = /[",\n\r]/;

export function csvCell(v: unknown): string {
  if (v == null) return '';
  let s = String(v);
  const neutralized = FORMULA_PREFIX.test(s);
  if (neutralized) s = "'" + s;
  return neutralized || QUOTE_TRIGGER.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
