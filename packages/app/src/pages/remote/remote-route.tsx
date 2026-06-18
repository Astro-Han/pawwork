import { useSurfacePage } from "@/pages/layout/surface-page-context"
import { RemoteSurface } from "./remote-surface"

// /remote route. A first-class surface (peer of /automations); close unwinds to
// the recorded origin via the shell's surface-page context.
export default function RemoteRoute() {
  const surface = useSurfacePage()
  return <RemoteSurface onClose={surface.close} />
}
