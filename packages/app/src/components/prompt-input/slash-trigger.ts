// Position-independent slash trigger, kept as a standalone pure module so it can
// be unit-tested without importing the editor-input factory (which pulls in
// @solidjs/router and throws in the server-side test env). Used by both the
// trigger detection in handleInput and the range-replace in addPart.

// Group 1 is the consuming boundary (start, whitespace, or a CJK script char) so
// the picker opens mid-sentence; group 2 is the query. The boundary set
// deliberately excludes ASCII word chars and `.`/`:`, and the query class stops
// at `/ \ :`, so paths/URLs/fractions (foo/bar, http://, 2/3) never trigger.
export const SLASH_TRIGGER =
  /(^|[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])\/([^\s\/\\:]*)$/u

/**
 * Match a slash trigger at the end of the text before the cursor. Returns the
 * query (text after "/") and the offset of the "/" itself (the boundary char in
 * group 1 is left in place), or null when no trigger fires.
 */
export function matchSlashTrigger(textBeforeCursor: string): { query: string; offset: number } | null {
  const match = textBeforeCursor.match(SLASH_TRIGGER)
  if (!match) return null
  return {
    query: match[2] ?? "",
    offset: (match.index ?? 0) + match[1].length,
  }
}
