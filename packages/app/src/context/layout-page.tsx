import { createContext, useContext, type Accessor } from "solid-js"

export type LayoutPageContextValue = {
  pinnedIDs: Accessor<string[]>
  workspaceOrderFor: (worktree: string) => string[] | undefined
  openProject: () => void
  // Directory context for surfaces that are not under a /:dir route: the
  // current route directory when one is active, else the last one visited,
  // else the HomeRedirectRoute fallback chain. Empty only with zero projects.
  activeDirectory: Accessor<string>
}

export const LayoutPageContext = createContext<LayoutPageContextValue>()

export function useLayoutPage() {
  const value = useContext(LayoutPageContext)
  if (!value) throw new Error("LayoutPageContext is not available")
  return value
}
