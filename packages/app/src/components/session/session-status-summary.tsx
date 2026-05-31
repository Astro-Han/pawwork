import { For, Show, createMemo, type Accessor, type JSX } from "solid-js"
import { TodoStatusMarker } from "@opencode-ai/ui/todo-status-marker"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { Part, VcsInfo } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { canOpenLocalPath, usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { extractSources } from "@/pages/session/session-status-extractors"
import { selectSessionTodoDataSnapshot } from "@/pages/session/session-todos"
import type { SessionTodoItem } from "@/pages/session/todos/todo-model"
import type { CanonicalTodoSnapshot } from "@/pages/session/todos/todo-source"
import type { FilesTabEntry } from "@/pages/session/files-tab-state"

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-2 px-4 py-6">
      <div class="text-caption text-fg-weak">{props.title}</div>
      {props.children}
    </div>
  )
}

function Empty(props: { text: string }) {
  return <div class="text-body text-fg-weaker">{props.text}</div>
}

function TodoRow(props: { todo: SessionTodoItem }) {
  const isDone = () => props.todo.status === "completed" || props.todo.status === "cancelled"
  return (
    <div
      data-slot="status-summary-todo"
      data-state={props.todo.status}
      class="flex items-start gap-2 py-1"
    >
      <TodoStatusMarker status={props.todo.status} marginTop="1px" />
      <div
        class="text-body min-w-0 break-words"
        classList={{
          "line-through text-fg-weak": isDone(),
          "text-fg-base": !isDone(),
        }}
      >
        {props.todo.content}
      </div>
    </div>
  )
}

function SourceRow(props: { url: string }) {
  return (
    <div class="flex items-center gap-2 py-1" title={props.url}>
      <span class="text-body text-fg-base truncate min-w-0">{props.url}</span>
    </div>
  )
}

interface ActiveWorktree {
  name: string
  branch?: string
  directory?: string
}

function GitRow(props: {
  icon: string
  onClick?: () => void
  children: JSX.Element
  chevron?: "down" | "right" | false
  title?: string
}) {
  return (
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left transition-colors hover:bg-surface-raised"
      classList={{ "cursor-default": !props.onClick }}
      onClick={props.onClick}
      title={props.title}
    >
      <Icon name={props.icon as any} class="shrink-0 text-fg-weak" />
      <div class="min-w-0 flex-1">{props.children}</div>
      <Show when={props.chevron}>
        {(dir) => <Icon name={dir() === "down" ? "chevron-down" : "chevron-right"} class="shrink-0 text-fg-weaker" />}
      </Show>
    </button>
  )
}

function GitSection(props: {
  vcs: Accessor<VcsInfo | undefined>
  activeWorktree: Accessor<ActiveWorktree | undefined>
  diffStats: Accessor<{ additions: number; deletions: number }>
  onNavigateReview: () => void
  onOpenWorktreeDirectory: (directory: string) => void
}) {
  const language = useLanguage()
  const hasChanges = createMemo(() => {
    const stats = props.diffStats()
    return stats.additions > 0 || stats.deletions > 0
  })

  const worktreeTooltip = (worktree: ActiveWorktree) => (
    <div class="grid min-w-0 gap-1.5 py-1 text-left">
      <div class="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-start gap-3">
        <span class="text-caption">Worktree</span>
        <span class="text-h3 min-w-0 break-all leading-[1.45]">{worktree.name || "Not available"}</span>
      </div>
      <div class="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-start gap-3">
        <span class="text-caption">Branch</span>
        <span class="text-body min-w-0 break-all leading-[1.45]">{worktree.branch || "Not available"}</span>
      </div>
      <div class="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-start gap-3">
        <span class="text-caption">Location</span>
        <span class="text-body min-w-0 break-all leading-[1.45]">{worktree.directory || "Not available"}</span>
      </div>
    </div>
  )

  return (
    <Section title={language.t("status.summary.git")}>
      <div class="flex flex-col">
        <GitRow
          icon="changes"
          onClick={hasChanges() ? props.onNavigateReview : undefined}
          chevron={hasChanges() ? "right" : false}
        >
          <Show
            when={hasChanges()}
            fallback={<span class="text-body text-fg-weaker">{language.t("status.summary.git.changes")}</span>}
          >
            <span class="font-mono text-body">
              <span class="text-success">+{props.diffStats().additions}</span>
              {" "}
              <span class="text-error">−{props.diffStats().deletions}</span>
            </span>
          </Show>
        </GitRow>

        <Show when={props.vcs()?.branch}>
          {(branch) => (
            <GitRow icon="branch" chevron="down">
              <span class="text-body text-fg-base">{branch()}</span>
            </GitRow>
          )}
        </Show>

        <Show when={props.activeWorktree()}>
          {(worktree) => (
            <Tooltip
              placement="bottom"
              value={worktreeTooltip(worktree())}
              contentClass="max-w-[420px] px-3 py-2"
            >
              <GitRow
                icon="worktree"
                onClick={() => {
                  const directory = worktree().directory
                  if (directory) props.onOpenWorktreeDirectory(directory)
                }}
                title={language.t("status.summary.git.worktree.open")}
              >
                <span class="text-body text-fg-base">{worktree().name || worktree().branch || "Worktree"}</span>
              </GitRow>
            </Tooltip>
          )}
        </Show>
      </div>
    </Section>
  )
}

function ArtifactRow(props: {
  file: FilesTabEntry
  onOpen: () => void
  onReveal: () => void
}) {
  const language = useLanguage()
  const filename = createMemo(() => {
    const parts = props.file.path.split("/")
    return parts[parts.length - 1] || props.file.path
  })

  return (
    <div class="group flex items-center gap-2 py-1.5">
      <Icon name="review" class="shrink-0 text-fg-weak" />
      <span class="min-w-0 flex-1 truncate text-body text-fg-base" title={props.file.path}>
        {filename()}
      </span>
      <div class="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          class="flex size-6 items-center justify-center rounded text-fg-weak hover:bg-surface-raised hover:text-fg-strong"
          onClick={props.onOpen}
          title={language.t("status.summary.artifact.open")}
        >
          <Icon name="open-file" />
        </button>
        <button
          type="button"
          class="flex size-6 items-center justify-center rounded text-fg-weak hover:bg-surface-raised hover:text-fg-strong"
          onClick={props.onReveal}
          title={language.t("status.summary.artifact.reveal")}
        >
          <Icon name="folder" />
        </button>
      </div>
    </div>
  )
}

function ArtifactSection(props: {
  files: Accessor<FilesTabEntry[]>
  onOpenFile: (path: string) => void
  onRevealFile: (path: string) => void
}) {
  const language = useLanguage()

  return (
    <Section title={language.t("status.summary.artifact")}>
      <Show
        when={props.files().length > 0}
        fallback={<Empty text={language.t("status.summary.artifact.empty")} />}
      >
        <div class="flex flex-col">
          <For each={props.files()}>
            {(file) => (
              <ArtifactRow
                file={file}
                onOpen={() => props.onOpenFile(file.path)}
                onReveal={() => props.onRevealFile(file.path)}
              />
            )}
          </For>
        </div>
      </Show>
    </Section>
  )
}

export function SessionStatusSummary(props: {
  canonical?: Accessor<CanonicalTodoSnapshot | undefined>
  isAuthoritativelyInvalidated?: Accessor<boolean>
  isPending?: Accessor<boolean>
  parts: Accessor<Part[]>
  vcs?: Accessor<VcsInfo | undefined>
  activeWorktree?: Accessor<ActiveWorktree | undefined>
  diffStats?: Accessor<{ additions: number; deletions: number }>
  artifactFiles?: Accessor<FilesTabEntry[]>
  onNavigateReview?: () => void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()

  const snapshot = createMemo(() =>
    selectSessionTodoDataSnapshot({
      primary: {
        canonical: props.canonical?.(),
        isAuthoritativelyInvalidated: props.isAuthoritativelyInvalidated?.() ?? false,
        isPending: props.isPending?.() ?? false,
        parts: props.parts(),
      },
    }),
  )
  const todos = createMemo(() => snapshot().items)
  const sources = createMemo(() => extractSources(props.parts()))

  const isGitRepo = createMemo(() => !!props.vcs?.()?.branch || !!props.activeWorktree?.())

  const navigateToReview = () => {
    props.onNavigateReview?.()
  }

  const openWorktreeDirectory = (directory: string) => {
    if (!canOpenLocalPath(platform) || !server.isLocal() || !platform.openPath) return
    void platform.openPath(directory).catch(() => {})
  }

  const openFile = (path: string) => {
    if (!platform.openPath) return
    void platform.openPath(path).catch(() => {})
  }

  const revealFile = (path: string) => {
    if (!platform.showItemInFolder) return
    void platform.showItemInFolder(path).catch(() => {})
  }

  return (
    <>
      <Show when={snapshot().phase !== "pending"}>
        <Section title={language.t("status.summary.progress")}>
          <Show when={todos().length > 0} fallback={<Empty text={language.t("status.summary.progress.empty")} />}>
            <div class="flex flex-col">
              <For each={todos()}>{(todo) => <TodoRow todo={todo} />}</For>
            </div>
          </Show>
        </Section>
      </Show>

      <Show when={isGitRepo() && props.vcs && props.diffStats}>
        <GitSection
          vcs={props.vcs!}
          activeWorktree={() => props.activeWorktree?.()}
          diffStats={props.diffStats!}
          onNavigateReview={navigateToReview}
          onOpenWorktreeDirectory={openWorktreeDirectory}
        />
      </Show>

      <Show when={props.artifactFiles}>
        {(files) => (
          <ArtifactSection
            files={files()}
            onOpenFile={openFile}
            onRevealFile={revealFile}
          />
        )}
      </Show>

      <Section title={language.t("status.summary.sources")}>
        <Show when={sources().length > 0} fallback={<Empty text={language.t("status.summary.sources.empty")} />}>
          <div class="flex flex-col">
            <For each={sources()}>{(url) => <SourceRow url={url} />}</For>
          </div>
        </Show>
      </Section>
    </>
  )
}
