export type HomeSuggestionChipID = "analyze-spreadsheet" | "news-brief" | "draft-email"

export interface HomeSuggestionChip {
  id: HomeSuggestionChipID
  i18nKey: string
}

export const HOME_SUGGESTION_CHIPS: readonly HomeSuggestionChip[] = [
  { id: "analyze-spreadsheet", i18nKey: "home.suggestion.analyze-spreadsheet" },
  { id: "news-brief", i18nKey: "home.suggestion.news-brief" },
  { id: "draft-email", i18nKey: "home.suggestion.draft-email" },
]

export interface ResolveHomeSuggestionsInput {
  firstTimeVisitor: boolean
  enabled: boolean
  dismissed: readonly HomeSuggestionChipID[]
}

export function resolveVisibleHomeSuggestions(input: ResolveHomeSuggestionsInput): HomeSuggestionChipID[] {
  if (!input.firstTimeVisitor) return []
  if (!input.enabled) return []
  const dismissedSet = new Set(input.dismissed)
  return HOME_SUGGESTION_CHIPS.map((chip) => chip.id).filter((id) => !dismissedSet.has(id))
}
