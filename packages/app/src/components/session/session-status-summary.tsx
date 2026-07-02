import { For, Show, createMemo, type Accessor } from "solid-js"
import { TodoStatusMarker } from "@opencode-ai/ui/todo-status-marker"
import { Icon } from "@opencode-ai/ui/icon"
import type { Part, VcsInfo } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { extractSources } from "@/pages/session/session-status-extractors"
import { selectSessionTodoDataSnapshot } from "@/pages/session/session-todos"
import type { SessionTodoItem } from "@/pages/session/todos/todo-model"
import type { CanonicalTodoSnapshot } from "@/pages/session/todos/todo-source"
import type { FilesTabEntry } from "@/pages/session/files-tab-state"
import { Empty, Section } from "./session-status-summary-shell"
import { GitSection, type ActiveWorktree } from "./session-status-summary-git"
import { ArtifactSection } from "./session-status-summary-artifact"

function TodoRow(props: { todo: SessionTodoItem }) {
  const isDone = () => props.todo.status === "completed" || props.todo.status === "cancelled"
  return (
    <div
      data-slot="status-summary-todo"
      data-state={props.todo.status}
      class="flex items-start gap-2 py-1 min-h-[26px]"
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

function SourceRow(props: { url: string; onOpen: (url: string) => void }) {
  const language = useLanguage()
  return (
    <button
      type="button"
      data-slot="status-summary-source"
      class="flex w-full min-h-[26px] items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-[var(--row-hover-overlay)]"
      onClick={() => props.onOpen(props.url)}
      title={props.url}
      aria-label={`${language.t("status.summary.sources.open")}: ${props.url}`}
    >
      <Icon name="square-arrow-top-right" class="shrink-0 text-fg-weak" />
      <span class="text-body text-fg-base truncate min-w-0">{props.url}</span>
    </button>
  )
}

// Pure composition. All platform-touching work (file stat, openPath /
// showItemInFolder / openLink wrappers, capability detection, failure toast)
// lives in SessionStatusPanel — this file only stitches the four sections and
// has no React-context dependency beyond useLanguage.
export function SessionStatusSummary(props: {
  canonical?: Accessor<CanonicalTodoSnapshot | undefined>
  isAuthoritativelyInvalidated?: Accessor<boolean>
  isPending?: Accessor<boolean>
  parts: Accessor<Part[]>
  vcs?: Accessor<VcsInfo | undefined>
  activeWorktree?: Accessor<ActiveWorktree | undefined>
  diffStats?: Accessor<{ additions: number; deletions: number }>
  artifactFiles?: Accessor<FilesTabEntry[]>
  diffsByPath?: Accessor<Map<string, { additions: number; deletions: number }>>
  canOpenWorktreeDirectory: (directory: string) => boolean
  canOpenArtifactFile: (path: string) => boolean
  canRevealArtifactFile: (path: string) => boolean
  onNavigateReview?: () => void
  onOpenWorktreeDirectory: (directory: string) => void
  onOpenArtifactFile: (path: string) => void
  onRevealArtifactFile: (path: string) => void
  onOpenSourceLink: (url: string) => void
}) {
  const language = useLanguage()

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

  const isGitRepo = createMemo(() => !!props.vcs?.() || !!props.activeWorktree?.())

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
          onNavigateReview={() => props.onNavigateReview?.()}
          canOpenDirectory={props.canOpenWorktreeDirectory}
          onOpenDirectory={props.onOpenWorktreeDirectory}
        />
      </Show>

      <Show when={props.artifactFiles}>
        {(files) => (
          <ArtifactSection
            files={files()}
            diffsByPath={props.diffsByPath}
            canOpenFile={props.canOpenArtifactFile}
            canRevealFile={props.canRevealArtifactFile}
            onOpenFile={props.onOpenArtifactFile}
            onRevealFile={props.onRevealArtifactFile}
          />
        )}
      </Show>

      <Section title={language.t("status.summary.sources")}>
        <Show when={sources().length > 0} fallback={<Empty text={language.t("status.summary.sources.empty")} />}>
          <div class="flex flex-col">
            <For each={sources()}>{(url) => <SourceRow url={url} onOpen={props.onOpenSourceLink} />}</For>
          </div>
        </Show>
      </Section>
    </>
  )
}
