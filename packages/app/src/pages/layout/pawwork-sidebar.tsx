import type { Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { SessionItem } from "./sidebar-items"

export type PawworkSidebarSession = {
  session: Session
  slug: string
  projectLabel: string
}

export const PawworkSidebar = (props: {
  mobile?: boolean
  sessions: Accessor<PawworkSidebarSession[]>
  showProjectEmptyState: boolean
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
  onNew: () => void
  onSearch: () => void
  onOpenProject: () => void
}): JSX.Element => {
  const language = useLanguage()
  const navList = createMemo(() => props.sessions().map((item) => item.session))

  return (
    <section
      data-component="pawwork-sidebar"
      class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l border-t border-border-weaker-base bg-background-base px-3"
    >
      <div class="shrink-0 border-b border-border-weaker-base py-3">
        <div class="px-2 text-14-medium text-text-strong">PawWork</div>
        <div class="mt-3 flex flex-col gap-2">
          <Button data-action="pawwork-session-new" size="large" icon="new-session" class="w-full" onClick={props.onNew}>
            {language.t("command.session.new")}
          </Button>
          <Button data-action="pawwork-session-search" size="large" variant="ghost" class="w-full" onClick={props.onSearch}>
            {language.t("sidebar.pawwork.search")}
          </Button>
        </div>
      </div>

      <Show
        when={!props.showProjectEmptyState}
        fallback={
          <div class="flex flex-1 items-center px-3">
            <div class="flex w-full flex-col gap-3 rounded-xl border border-border-weak-base bg-surface-base p-4">
              <div class="text-14-medium text-text-strong">{language.t("sidebar.empty.title")}</div>
              <p class="text-13-regular text-text-weak">{language.t("sidebar.pawwork.empty.description")}</p>
              <Button data-action="pawwork-open-project" size="large" onClick={props.onOpenProject}>
                {language.t("command.project.open")}
              </Button>
            </div>
          </div>
        }
      >
        <div class="flex-1 min-h-0 overflow-y-auto py-3">
          <Show
            when={props.sessions().length > 0}
            fallback={<div class="px-2 text-13-regular text-text-weak">{language.t("sidebar.pawwork.empty.sessions")}</div>}
          >
            <nav class="flex flex-col gap-1">
              <For each={props.sessions()}>
                {(item) => (
                  <SessionItem
                    session={item.session}
                    list={navList()}
                    navList={navList}
                    slug={item.slug}
                    mobile={props.mobile}
                    showChild
                    sidebarExpanded={props.sidebarExpanded}
                    clearHoverProjectSoon={props.clearHoverProjectSoon}
                    prefetchSession={props.prefetchSession}
                    archiveSession={props.archiveSession}
                  />
                )}
              </For>
            </nav>
          </Show>
        </div>
      </Show>
    </section>
  )
}
