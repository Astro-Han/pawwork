import { createContext, useContext, type Accessor } from "solid-js"

export type LayoutPageContextValue = {
  pinnedIDs: Accessor<string[]>
  workspaceOrderFor: (worktree: string) => string[] | undefined
  openProject: () => void
}

export const LayoutPageContext = createContext<LayoutPageContextValue>()

export function useLayoutPage() {
  const value = useContext(LayoutPageContext)
  if (!value) throw new Error("LayoutPageContext is not available")
  return value
}
