import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { createStableLayoutMemo } from "./stable-layout-memo"

export function sessionRouteLayoutKey(params: { dir: string | undefined; id: string | undefined }) {
  return `${params.dir}${params.id ? "/" + params.id : ""}`
}

export const useSessionRouteKey = () => {
  const params = useParams() as { dir: string | undefined; id: string | undefined }
  const layoutRouteKey = createMemo(() => sessionRouteLayoutKey(params))
  return { params, layoutRouteKey }
}

export const useSessionLayout = () => {
  const layout = useLayout()
  const { params, layoutRouteKey } = useSessionRouteKey()
  return {
    params,
    layoutRouteKey,
    tabs: createStableLayoutMemo(() => layout.tabs(layoutRouteKey)),
    view: createStableLayoutMemo(() => layout.view(layoutRouteKey)),
  }
}
