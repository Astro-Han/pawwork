export type HomeSuggestionChipID = "folder-organize" | "excel-analysis" | "ppt-outline"

export interface HomeSuggestionChip {
  id: HomeSuggestionChipID
  // Short text shown in the row. Should be a substring of the prompt so the
  // existing e2e prefill assertion (editor contains row text) still holds.
  labelKey: string
  // Full prefilled prompt sent to the agent on click. Substantially longer
  // than labelKey by design: gives the agent task verb, output spec, and tool
  // hint, while showing the user what a good prompt looks like.
  promptKey: string
}

export const HOME_SUGGESTION_CHIPS: readonly HomeSuggestionChip[] = [
  {
    id: "folder-organize",
    labelKey: "home.suggestion.folder-organize.label",
    promptKey: "home.suggestion.folder-organize.prompt",
  },
  {
    id: "excel-analysis",
    labelKey: "home.suggestion.excel-analysis.label",
    promptKey: "home.suggestion.excel-analysis.prompt",
  },
  {
    id: "ppt-outline",
    labelKey: "home.suggestion.ppt-outline.label",
    promptKey: "home.suggestion.ppt-outline.prompt",
  },
]

export interface ResolveHomeSuggestionsInput {
  firstTimeVisitor: boolean
  dismissed: readonly HomeSuggestionChipID[]
}

export function resolveVisibleHomeSuggestions(input: ResolveHomeSuggestionsInput): HomeSuggestionChipID[] {
  if (!input.firstTimeVisitor) return []
  const dismissedSet = new Set(input.dismissed)
  return HOME_SUGGESTION_CHIPS.map((chip) => chip.id).filter((id) => !dismissedSet.has(id))
}
