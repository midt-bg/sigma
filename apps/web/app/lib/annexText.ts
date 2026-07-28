// Display-only shaping of raw annex (изменение) text from ЦАИС ЕОП. The source strings are legal
// amendment clauses pasted as one run-on block — often several thousand characters with clause
// numbers jammed together („…така: 2.  Чл. 16, ал. 3…"). We never rewrite the wording; we only
// normalize whitespace, split on clause boundaries for readable paragraphs, and cut a short
// preview for the collapsed table cell.

/** Characters shown in the collapsed preview of a long annex description. */
export const ANNEX_PREVIEW_CHARS = 180;

/** Slack over the preview length under which we show the full text without an expander —
 *  a "покажи още" that reveals one extra word is worse than no expander at all. */
export const ANNEX_EXPAND_SLACK = 60;

/** Collapse whitespace runs (the raw text mixes NBSPs, double spaces and newlines) and trim. */
export function normalizeAnnexText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Split normalized annex text into display paragraphs on legal clause boundaries:
 *  „§ 1." paragraph markers, numbered amendment items followed by „Чл." („2. Чл. 16 се изменя…"),
 *  and roman-numeral section markers („III. Останалите клаузи…"). Deliberately conservative —
 *  lowercase „чл." references mid-sentence never split. */
export function annexParagraphs(raw: string): string[] {
  const text = normalizeAnnexText(raw);
  return text
    .split(/(?=§\s*\d+)|(?<=[\s:;])(?=\d+\.\s*Чл)|(?<=\s)(?=[IVX]{1,4}\.\s)/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Cut the preview at a word boundary near ANNEX_PREVIEW_CHARS, with an ellipsis. */
export function annexPreview(raw: string): string {
  const text = normalizeAnnexText(raw);
  if (text.length <= ANNEX_PREVIEW_CHARS + ANNEX_EXPAND_SLACK) return text;
  const cut = text.slice(0, ANNEX_PREVIEW_CHARS + 1);
  const atWord = cut.slice(0, cut.lastIndexOf(' '));
  return `${(atWord.length > 0 ? atWord : cut.slice(0, ANNEX_PREVIEW_CHARS)).replace(/[\s,;:.]+$/, '')}…`;
}

/** True when the text is long enough to warrant the collapse/expand treatment. */
export function annexNeedsExpand(raw: string): boolean {
  return normalizeAnnexText(raw).length > ANNEX_PREVIEW_CHARS + ANNEX_EXPAND_SLACK;
}
