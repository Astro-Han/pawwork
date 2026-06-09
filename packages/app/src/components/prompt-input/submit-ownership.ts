import type { PromptRouteScope } from "@/pages/session/prompt-route-scope"
import type { PinnedDraftOwner } from "./pinned-draft"

/**
 * Submit ownership identifies which draft owner a given submit attempt operates on.
 * Captured once at the top of handleSubmit and frozen for the lifetime of that submit.
 * Used by clearInput/restoreInput so a successful clear or failure restore only
 * touches the owner whose revision matches the captured value at submit time.
 */
export type SubmitOwnership =
  | { kind: "pinned"; revision: number; directory: string }
  | { kind: "route"; scope: PromptRouteScope }

/**
 * Decide which owner owns this submit. A pinned deep-link slot owns homepage
 * submit only while it still matches the current homepage directory. Otherwise
 * ownership is the prompt store for the route scope captured at submit time.
 */
export function detectSubmitOwnership(params: {
  isHomepage: boolean
  pinned: PinnedDraftOwner
  sourceFilesystemDirectory: string
  routeScope: PromptRouteScope
}): SubmitOwnership {
  if (params.isHomepage) {
    const pinnedSlot = params.pinned.current()
    if (pinnedSlot && pinnedSlot.directory === params.sourceFilesystemDirectory) {
      return { kind: "pinned", revision: pinnedSlot.revision, directory: pinnedSlot.directory }
    }
  }
  return { kind: "route", scope: params.routeScope }
}
