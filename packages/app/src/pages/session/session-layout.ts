import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"

export const useSessionKey = () => {
  const params = useParams()
  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  return { params, sessionKey }
}

export const useSessionLayout = () => {
  const layout = useLayout()
  const { params, sessionKey } = useSessionKey()
  return {
    params,
    sessionKey,
    tabs: createStableLayoutMemo(() => layout.tabs(sessionKey)),
    view: createStableLayoutMemo(() => layout.view(sessionKey)),
  }
}

export function createStableLayoutMemo<T>(read: () => T) {
  let last: { value: T } | undefined
  const memo = createMemo(read)

  return () => {
    const value = memo()
    if (value !== undefined) {
      last = { value }
      return value
    }

    if (last) return last.value

    throw new Error("Stable layout memo read before initialization")
  }
}
