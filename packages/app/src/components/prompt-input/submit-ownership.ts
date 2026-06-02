import type { PromptRouteScope } from "@/pages/session/prompt-route-scope"
import type { PortableDraftOwner } from "./portable-draft"
import type { PinnedDraftOwner } from "./pinned-draft"

/**
 * Submit ownership identifies which draft owner a given submit attempt operates on.
 * Captured once at the top of handleSubmit and frozen for the lifetime of that submit.
 * Used by clearInput/restoreInput so a successful clear or failure restore only
 * touches the owner whose revision matches the captured value at submit time.
 */
export type SubmitOwnership =
  | { kind: "portable"; revision: number; sourceFilesystemDirectory: string }
  | { kind: "pinned"; revision: number; directory: string }
  | { kind: "route"; scope: PromptRouteScope }

/**
 * Decide which owner owns this submit. Pinned beats portable when both match the
 * current homepage directory. When on a concrete session route (id present),
 * ownership is always the route-scoped prompt store.
 */
export function detectSubmitOwnership(params: {
  isHomepage: boolean
  pinned: PinnedDraftOwner
  portable: PortableDraftOwner
  sourceFilesystemDirectory: string
  routeScope: PromptRouteScope
}): SubmitOwnership {
  if (params.isHomepage) {
    const pinnedSlot = params.pinned.current()
    if (pinnedSlot && pinnedSlot.directory === params.sourceFilesystemDirectory) {
      return { kind: "pinned", revision: pinnedSlot.revision, directory: pinnedSlot.directory }
    }
    const portableSnapshot = params.portable.snapshot()
    if (portableSnapshot && portableSnapshot.sourceFilesystemDirectory === params.sourceFilesystemDirectory) {
      return {
        kind: "portable",
        revision: portableSnapshot.revision,
        sourceFilesystemDirectory: portableSnapshot.sourceFilesystemDirectory,
      }
    }
  }
  return { kind: "route", scope: params.routeScope }
}
