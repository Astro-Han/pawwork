import { Button } from "@opencode-ai/ui/button"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { Dynamic } from "solid-js/web"
import { For, Match, Show, Switch, createEffect, createMemo, createResource } from "solid-js"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { FilesTabEntry } from "./files-tab-state"

const TEXT_PREVIEW_EXTENSIONS = new Set([".md", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml"])
const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx", ".pdf"])
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"])

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function extname(file: string) {
  const clean = file.replace(/[?#].*$/, "")
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"))
  const base = slash >= 0 ? clean.slice(slash + 1) : clean
  const dot = base.lastIndexOf(".")
  return dot >= 0 ? base.slice(dot).toLowerCase() : ""
}

export function FilesTab(props: { files: FilesTabEntry[] }) {
  const file = useFile()
  const language = useLanguage()
  const platform = usePlatform()
  const fileComponent = useFileComponent()

  const previewable = createMemo(() =>
    props.files.filter((item) => {
      const ext = extname(item.path)
      return TEXT_PREVIEW_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)
    }),
  )

  createEffect(() => {
    for (const item of previewable()) {
      void file.load(item.path)
    }
  })

  const [stats] = createResource(
    () => props.files.map((item) => item.path),
    async (paths) => {
      if (paths.length === 0) return {}
      if (!platform.statPaths) {
        return Object.fromEntries(paths.map((item) => [item, { size: 0, exists: true }]))
      }
      return platform.statPaths(paths)
    },
  )

  const preview = (entry: FilesTabEntry) => {
    const state = file.get(entry.path)
    const content = state?.content
    const ext = extname(entry.path)

    if (!TEXT_PREVIEW_EXTENSIONS.has(ext) && !IMAGE_EXTENSIONS.has(ext)) {
      return (
        <div class="text-13-regular text-text-weak">
          {OFFICE_EXTENSIONS.has(ext) ? entry.file : language.t("session.files.binaryContent")}
        </div>
      )
    }

    if (state?.loading) return <div class="text-13-regular text-text-weak">{language.t("common.loading")}...</div>
    if (!content) return null

    if (IMAGE_EXTENSIONS.has(ext) || content.mimeType?.startsWith("image/")) {
      const src =
        content.type === "binary" && content.encoding === "base64"
          ? `data:${content.mimeType ?? "application/octet-stream"};base64,${content.content}`
          : `data:${content.mimeType ?? "text/plain"};charset=utf-8,${encodeURIComponent(content.content)}`
      return (
        <img
          src={src}
          alt={entry.file}
          class="max-h-48 w-full rounded-md border border-border-weaker-base object-contain bg-background-base"
        />
      )
    }

    if (content.type !== "text") {
      return <div class="text-13-regular text-text-weak">{language.t("session.files.binaryContent")}</div>
    }

    return (
      <div class="max-h-56 overflow-hidden rounded-md border border-border-weaker-base bg-background-base">
        <Dynamic
          component={fileComponent}
          mode="text"
          file={{
            name: entry.path,
            contents: content.content,
            cacheKey: entry.path,
          }}
        />
      </div>
    )
  }

  return (
    <ScrollView class="h-full">
      <Show
        when={props.files.length > 0}
        fallback={
          <div class="px-6 py-6 text-13-regular text-text-weak">
            {language.t("session.files.empty")}
          </div>
        }
      >
        <div class="p-3 flex flex-col gap-3">
          <For each={props.files}>
            {(entry) => {
              const meta = createMemo(() => stats()?.[entry.path] ?? { size: 0, exists: false })

              return (
                <section
                  data-artifact-file={entry.file}
                  class="rounded-xl border border-border-weaker-base bg-background-stronger p-3 flex flex-col gap-3"
                >
                  <div class="flex items-start gap-3">
                    <FileIcon node={{ path: entry.path, type: "file" }} class="shrink-0 mt-0.5" />
                    <div class="min-w-0 flex-1">
                      <div class="text-13-medium text-text-strong break-all">{entry.file}</div>
                      <div class="mt-1 flex items-center gap-2 text-13-regular text-text-weak">
                        <span>{entry.kind === "added" ? "Added" : "Updated"}</span>
                        <span aria-hidden>•</span>
                        <span>{meta().exists ? formatSize(meta().size) : "Missing"}</span>
                      </div>
                    </div>
                  </div>

                  <Switch>
                    <Match when={!meta().exists}>
                      <div class="text-13-regular text-text-weak">File not found</div>
                    </Match>
                    <Match when={true}>{preview(entry)}</Match>
                  </Switch>

                  <div class="flex items-center gap-2">
                    <Button
                      size="small"
                      disabled={!meta().exists || !platform.openPath}
                      onClick={() => platform.openPath?.(entry.path)}
                      aria-label={language.t("command.file.open")}
                    >
                      {language.t("command.file.open")}
                    </Button>
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={!meta().exists || !platform.showItemInFolder}
                      onClick={() => platform.showItemInFolder?.(entry.path)}
                      aria-label={language.t("command.file.revealInFolder")}
                    >
                      {language.t("command.file.revealInFolder")}
                    </Button>
                  </div>
                </section>
              )
            }}
          </For>
        </div>
      </Show>
    </ScrollView>
  )
}
