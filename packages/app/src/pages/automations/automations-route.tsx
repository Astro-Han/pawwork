import { useLocation } from "@solidjs/router"
import { createMemo } from "solid-js"
import { readSurfaceRouteState } from "@/pages/layout/surface-routes"
import { useSurfacePage } from "@/pages/layout/surface-page-context"
import { AutomationsSurface } from "./automations-surface"

// /automations route. A deep entry (the automate tool card's jump) carries
// the requested automation in the navigation state, so a stale request can
// never outlive its own history entry.
export default function AutomationsRoute() {
  const surface = useSurfacePage()
  const location = useLocation()
  const requestedID = createMemo(() => readSurfaceRouteState(location.state)?.automationID)
  return (
    <AutomationsSurface
      directory={surface.automations.directory}
      projectID={surface.automations.projectID}
      requestedID={requestedID}
      onClose={surface.close}
      onOpenRun={surface.automations.openRun}
      onOpenProject={surface.automations.openProject}
      onCreateViaChat={surface.automations.createViaChat}
    />
  )
}
