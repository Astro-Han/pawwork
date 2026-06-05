import { onMount, untrack } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/util/encode"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { useServer } from "@/context/server"
import type { useNotification } from "@/context/notification"
import type { useLayout } from "@/context/layout"
import type { usePinnedDraft } from "@/components/prompt-input/pinned-draft"
import { setSessionHandoff } from "@/pages/session/handoff"
import { openProjectRoute } from "./helpers"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "./deep-links"
import type { createShellNavigation } from "./shell-navigation"
import { createDefaultLayoutPageState } from "./layout-page-store"

type LayoutPageState = ReturnType<typeof createDefaultLayoutPageState>

export type PawworkRoutingActionsInput = {
  navigate: (href: string) => void
  server: Pick<ReturnType<typeof useServer>, "isLocal" | "projects">
  store: LayoutPageState
  setStore: SetStoreFunction<LayoutPageState>
  notification: Pick<ReturnType<typeof useNotification>, "session">
  scrollToSession: (sessionId: string, sessionKey: string) => void
  pinned: Pick<ReturnType<typeof usePinnedDraft>, "adopt">
  projectRoot: (directory: string) => string
  activeProjectRoot: (directory: string) => string
  shellNavigation: Pick<ReturnType<typeof createShellNavigation>, "openSession" | "openNewSession">
  layout: Pick<ReturnType<typeof useLayout>, "projects">
}

export function createPawworkRoutingActions(input: PawworkRoutingActionsInput) {
  function syncSessionRoute(directory: string, id: string, root = input.activeProjectRoot(directory)) {
    input.notification.session.markViewed(id)
    const expanded = untrack(() => input.store.workspaceExpanded[directory])
    if (expanded === false) {
      input.setStore("workspaceExpanded", directory, true)
    }
    requestAnimationFrame(() => input.scrollToSession(id, `${directory}:${id}`))
    return root
  }

  async function navigateToProject(directory: string | undefined) {
    if (!directory) return
    const root = input.projectRoot(directory)
    input.server.projects.touch(root)
    input.navigate(openProjectRoute(root))
  }

  function navigateToSession(session: Session | undefined) {
    input.shellNavigation.openSession(session)
  }

  function openPawworkHome(directory?: string) {
    input.shellNavigation.openNewSession(directory)
  }

  function openProject(directory: string, shouldNavigate = true) {
    input.layout.projects.open(directory)
    if (shouldNavigate) return navigateToProject(directory)
  }

  const handleDeepLinks = (urls: string[]) => {
    if (!input.server.isLocal()) return

    for (const directory of collectOpenProjectDeepLinks(urls)) {
      openProject(directory)
    }

    for (const link of collectNewSessionDeepLinks(urls)) {
      openProject(link.directory, false)
      const slug = base64Encode(link.directory)
      if (link.prompt) {
        // Pin the prompt to this directory so it is NOT carried portably to
        // other homepages. The pinned slot is consumed by editor-input.ts when
        // the user lands on the /repo homepage.
        input.pinned.adopt({ directory: link.directory, prompt: link.prompt })
        // Also keep the session handoff for the new-session composer region
        // that shows the prefill text before the session is created (T7 will
        // decide whether to clear it on submit).
        setSessionHandoff(slug, { prompt: link.prompt })
      }
      const href = `/${slug}/session`
      input.navigate(href)
    }
  }

  onMount(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ urls: string[] }>).detail
      const urls = detail?.urls ?? []
      if (urls.length === 0) return
      handleDeepLinks(urls)
    }

    handleDeepLinks(drainPendingDeepLinks(window))
    makeEventListener(window, deepLinkEvent, handler as EventListener)
  })

  return {
    syncSessionRoute,
    navigateToProject,
    navigateToSession,
    openPawworkHome,
    openProject,
    handleDeepLinks,
  }
}
