import { useParams } from "@solidjs/router"
import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createSortable } from "@thisbeyond/solid-dnd"
import { createMediaQuery } from "@solid-primitives/media"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { Button } from "@opencode-ai/ui/button"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { type LocalProject } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { NewSessionItem, SessionItem, SessionSkeleton } from "./sidebar-items"
import { sortedRootSessions, workspaceKey } from "./helpers"

type InlineEditorComponent = (props: {
  id: string
  value: Accessor<string>
  onSave: (next: string) => void
  class?: string
  displayClass?: string
  editing?: boolean
  stopPropagation?: boolean
  openOnDblClick?: boolean
}) => JSX.Element

export type WorkspaceSidebarContext = {
  currentDir: Accessor<string>
  navList: Accessor<Session[]>
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  openSession: (session: Session) => void
  openNewSession: (directory: string) => void
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
  renameWorkspace: (directory: string, next: string, projectId?: string, branch?: string) => void
  editorOpen: (id: string) => boolean
  openEditor: (id: string, value: string) => void
  closeEditor: () => void
  setEditor: (key: "value", value: string) => void
  InlineEditor: InlineEditorComponent
  isBusy: (directory: string) => boolean
  workspaceExpanded: (directory: string, local: boolean) => boolean
  setWorkspaceExpanded: (directory: string, value: boolean) => void
  showResetWorkspaceDialog: (root: string, directory: string) => void
  showDeleteWorkspaceDialog: (root: string, directory: string) => void
  setScrollContainerRef: (el: HTMLDivElement | undefined) => void
}

const WorkspaceHeader = (props: {
  local: Accessor<boolean>
  busy: Accessor<boolean>
  open: Accessor<boolean>
  directory: string
  language: ReturnType<typeof useLanguage>
  branch: Accessor<string | undefined>
  workspaceValue: Accessor<string>
  workspaceEditActive: Accessor<boolean>
  InlineEditor: WorkspaceSidebarContext["InlineEditor"]
  renameWorkspace: WorkspaceSidebarContext["renameWorkspace"]
  setEditor: WorkspaceSidebarContext["setEditor"]
  projectId?: string
}): JSX.Element => (
  <div class="flex items-center gap-1 min-w-0 flex-1">
    <div class="flex items-center justify-center shrink-0 size-6">
      <Show when={props.busy()} fallback={<Icon name="branch" />}>
        <Spinner class="size-[15px]" />
      </Show>
    </div>
    <span class="text-13-medium text-fg-base shrink-0">
      {props.local() ? props.language.t("workspace.type.local") : props.language.t("workspace.type.sandbox")} :
    </span>
    <Show
      when={!props.local()}
      fallback={
        <span class="text-13-medium text-fg-base min-w-0 truncate">
          {props.branch() ?? getFilename(props.directory)}
        </span>
      }
    >
      <props.InlineEditor
        id={`workspace:${props.directory}`}
        value={props.workspaceValue}
        onSave={(next) => {
          const trimmed = next.trim()
          if (!trimmed) return
          props.renameWorkspace(props.directory, trimmed, props.projectId, props.branch())
          props.setEditor("value", props.workspaceValue())
        }}
        class="text-13-medium text-fg-base min-w-0 truncate"
        displayClass="text-13-medium text-fg-base min-w-0 truncate"
        editing={props.workspaceEditActive()}
        stopPropagation={false}
        openOnDblClick={false}
      />
    </Show>
    <div class="flex items-center justify-center shrink-0 overflow-hidden w-0 opacity-0 transition-all duration-200 group-hover/workspace:w-3.5 group-hover/workspace:opacity-100 group-focus-within/workspace:w-3.5 group-focus-within/workspace:opacity-100">
      <Icon name={props.open() ? "chevron-down" : "chevron-right"} class="text-icon-base" />
    </div>
  </div>
)

const WorkspaceActions = (props: {
  directory: string
  local: Accessor<boolean>
  busy: Accessor<boolean>
  menuOpen: Accessor<boolean>
  pendingRename: Accessor<boolean>
  setMenuOpen: (open: boolean) => void
  setPendingRename: (value: boolean) => void
  touch: Accessor<boolean>
  language: ReturnType<typeof useLanguage>
  workspaceValue: Accessor<string>
  openEditor: WorkspaceSidebarContext["openEditor"]
  showResetWorkspaceDialog: WorkspaceSidebarContext["showResetWorkspaceDialog"]
  showDeleteWorkspaceDialog: WorkspaceSidebarContext["showDeleteWorkspaceDialog"]
  root: string
  openNewSession: () => void
}): JSX.Element => (
  <div
    class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 transition-opacity"
    classList={{
      "opacity-100 pointer-events-auto": props.menuOpen(),
      "opacity-0 pointer-events-none": !props.menuOpen(),
      "group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto": true,
      "group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto": true,
    }}
  >
    <DropdownMenu
      modal={true}
      open={props.menuOpen()}
      onOpenChange={(open) => props.setMenuOpen(open)}
    >
      <Tooltip value={props.language.t("common.moreOptions")} placement="top">
        <DropdownMenu.Trigger
          as={IconButton}
          icon="dot-grid"
          variant="ghost"
          class="h-[26px] w-[26px] rounded-md"
          data-action="workspace-menu"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("common.moreOptions")}
        />
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          onCloseAutoFocus={(event) => {
            if (!props.pendingRename()) return
            event.preventDefault()
            props.setPendingRename(false)
            props.openEditor(`workspace:${props.directory}`, props.workspaceValue())
          }}
        >
          <DropdownMenu.Item
            disabled={props.local()}
            onSelect={() => {
              props.setPendingRename(true)
              props.setMenuOpen(false)
            }}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.rename")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showResetWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.reset")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={props.local() || props.busy()}
            onSelect={() => props.showDeleteWorkspaceDialog(props.root, props.directory)}
          >
            <DropdownMenu.ItemLabel>{props.language.t("common.delete")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
    <Show when={!props.touch()}>
      <Tooltip value={props.language.t("command.session.new")} placement="top">
        <IconButton
          icon="new-session"
          variant="ghost"
          class="h-[26px] w-[26px] rounded-md opacity-0 pointer-events-none group-hover/workspace:opacity-100 group-hover/workspace:pointer-events-auto group-focus-within/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto"
          data-action="workspace-new-session"
          data-workspace={base64Encode(props.directory)}
          aria-label={props.language.t("command.session.new")}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            props.openNewSession()
          }}
        />
      </Tooltip>
    </Show>
  </div>
)

const WorkspaceSessionList = (props: {
  slug: Accessor<string>
  directory: string
  ctx: WorkspaceSidebarContext
  showNew: Accessor<boolean>
  loading: Accessor<boolean>
  sessions: Accessor<Session[]>
  hasMore: Accessor<boolean>
  loadMore: () => Promise<void>
  language: ReturnType<typeof useLanguage>
}): JSX.Element => (
  <nav class="flex flex-col gap-1">
    <Show when={props.showNew()}>
      <NewSessionItem slug={props.slug()} onOpenNewSession={() => props.ctx.openNewSession(props.directory)} />
    </Show>
    <Show when={props.loading()}>
      <SessionSkeleton />
    </Show>
    <For each={props.sessions()}>
      {(session) => (
        <SessionItem
          session={session}
          list={props.sessions()}
          navList={props.ctx.navList}
          slug={props.slug()}
          showChild
          prefetchSession={props.ctx.prefetchSession}
          onOpenSession={props.ctx.openSession}
        />
      )}
    </For>
    <Show when={props.hasMore()}>
      <div class="relative w-full py-1">
        <Button
          variant="ghost"
          class="flex w-full text-left justify-start text-13-regular text-fg-weak pl-2 pr-10"
          size="large"
          onClick={(e: MouseEvent) => {
            props.loadMore()
            ;(e.currentTarget as HTMLButtonElement).blur()
          }}
        >
          {props.language.t("common.loadMore")}
        </Button>
      </div>
    </Show>
  </nav>
)

