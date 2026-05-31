import { For, Show, createMemo, type Accessor } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { normalizeArtifactPathKey, type FilesTabEntry } from "@/pages/session/files-tab-state"
import { Empty, Section } from "./session-status-summary-shell"

// One row in the Changed files section. Rest state shows +N -N diff stats in
// mono-small; hover/focus fades them out and reveals open + reveal IconButtons
// (the turn-change trailing pattern from packages/ui/src/components/session-turn.css).
//
// Each action button derives its disabled state from a per-row capability flag
// supplied by the host. Capability false means: the platform shell can't open
// this kind of path (web), the local server isn't local, or the file no longer
// exists on disk. Disabled buttons still render so the trailing slot keeps its
// width and the user gets a hover affordance for the row.
function ArtifactRow(props: {
  file: FilesTabEntry
  diff?: { additions: number; deletions: number }
  canOpen: boolean
  canReveal: boolean
  onOpen: () => void
  onReveal: () => void
}) {
  const language = useLanguage()
  const filename = createMemo(() => {
    const parts = props.file.path.replace(/\\/g, "/").split("/")
    return parts[parts.length - 1] || props.file.path
  })

  return (
    <div
      data-slot="status-summary-artifact"
      class="group grid min-h-[30px] items-center gap-[var(--space-sm)] px-3 rounded-md transition-colors hover:bg-[var(--row-hover-overlay)]"
      style={{ "grid-template-columns": "16px minmax(0, 1fr) minmax(60px, max-content)" }}
    >
      <Icon name="review" class="size-4 shrink-0 text-fg-weak" />
      <span class="min-w-0 truncate text-body text-fg-strong" title={props.file.path}>
        {filename()}
      </span>
      <span class="relative inline-flex h-full items-center justify-end">
        <Show when={props.diff}>
          {(diff) => (
            <span class="inline-flex items-baseline gap-2 text-mono-small whitespace-nowrap transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              <span class="text-success tabular-nums">+{diff().additions}</span>
              <span class="text-error tabular-nums">−{diff().deletions}</span>
            </span>
          )}
        </Show>
        <span class="pointer-events-none absolute inset-0 inline-flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <Tooltip value={language.t("status.summary.artifact.open")} placement="top">
            <IconButton
              icon="open-file"
              aria-label={language.t("status.summary.artifact.open")}
              disabled={!props.canOpen}
              onClick={props.onOpen}
              class="!size-[26px] !rounded-[var(--radius-md)] hover:!bg-[var(--row-active-overlay)]"
            />
          </Tooltip>
          <Tooltip value={language.t("status.summary.artifact.reveal")} placement="top">
            <IconButton
              icon="folder-add-left"
              aria-label={language.t("status.summary.artifact.reveal")}
              disabled={!props.canReveal}
              onClick={props.onReveal}
              class="!size-[26px] !rounded-[var(--radius-md)] hover:!bg-[var(--row-active-overlay)]"
            />
          </Tooltip>
        </span>
      </span>
    </div>
  )
}

export function ArtifactSection(props: {
  files: Accessor<FilesTabEntry[]>
  diffsByPath?: Accessor<Map<string, { additions: number; deletions: number }>>
  canOpenFile: (path: string) => boolean
  canRevealFile: (path: string) => boolean
  onOpenFile: (path: string) => void
  onRevealFile: (path: string) => void
}) {
  const language = useLanguage()

  return (
    <Section title={language.t("status.summary.artifact")}>
      <Show when={props.files().length > 0} fallback={<Empty text={language.t("status.summary.artifact.empty")} />}>
        <div class="flex flex-col">
          <For each={props.files()}>
            {(file) => (
              <ArtifactRow
                file={file}
                diff={props.diffsByPath?.().get(normalizeArtifactPathKey(file.path))}
                canOpen={props.canOpenFile(file.path)}
                canReveal={props.canRevealFile(file.path)}
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
