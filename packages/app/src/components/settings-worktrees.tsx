import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { SettingsList } from "./settings-list"
import { basename, entryDirectory, errorText, sourceKey, type WorktreeInfo } from "./settings-worktrees-helpers"

export const SettingsWorktrees: Component = () => {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()

  const projectRoots = () =>
    sync.data.project
      .filter((project) => project.vcs === "git")
      .map((project) => project.worktree)
      .filter(Boolean)

  const [data, { refetch }] = createResource(
    () => projectRoots().join("\0"),
    async () => {
      const rows = await Promise.all(
        projectRoots().map(async (ownerDirectory) => {
          const res = await sdk.client.worktree.list({ directory: ownerDirectory })
          return (res.data ?? []).map((worktree) => ({ ...worktree, ownerDirectory }) as WorktreeInfo)
        }),
      )
      const byDirectory = new Map<string, WorktreeInfo>()
      for (const row of rows.flat()) byDirectory.set(row.directory, row)
      return Array.from(byDirectory.values())
    },
  )

  const boundSessions = (): Map<string, string> => {
    const map = new Map<string, string>()
    const directories = new Set<string>()
    for (const project of sync.data.project) {
      directories.add(project.worktree)
      for (const sandbox of project.sandboxes ?? []) directories.add(entryDirectory(sandbox))
    }
    for (const worktree of data() ?? []) {
      directories.add(worktree.ownerDirectory)
      directories.add(worktree.directory)
    }

    for (const directory of directories) {
      const [store] = sync.child(directory, { bootstrap: false })
      for (const s of store.session ?? []) {
        const exec = s.executionContext
        if (!exec) continue
        if (exec.activeDirectory && exec.activeDirectory !== exec.ownerDirectory) {
          map.set(exec.activeDirectory, s.title)
        }
      }
    }
    return map
  }

  const [confirming, setConfirming] = createSignal<string | undefined>(undefined)
  const [deleting, setDeleting] = createSignal<string | undefined>(undefined)

  const handleDelete = async (directory: string) => {
    setDeleting(directory)
    try {
      const ownerDirectory = data()?.find((worktree) => worktree.directory === directory)?.ownerDirectory ?? directory
      const res = await sdk.client.worktree.remove({ directory: ownerDirectory, worktreeRemoveInput: { directory } })
      if (res.error) throw new Error(errorText(res.error))
      setConfirming(undefined)
      void refetch()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({
        title: language.t("settings.worktrees.deleteFailed", { message }),
      })
    } finally {
      setDeleting(undefined)
    }
  }

  return (
    <SettingsList>
      <div class="flex flex-col gap-4 py-4">
        <div class="flex flex-col gap-1">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.worktrees.title")}</h2>
          <p class="text-13-regular text-text-weak max-w-[68ch]">{language.t("settings.worktrees.description")}</p>
        </div>

        <Show
          when={!data.loading}
          fallback={<div class="text-13-regular text-text-weak py-6 text-center">{language.t("common.loading")}</div>}
        >
          <Show
            when={(data() ?? []).length > 0}
            fallback={
              <div class="text-13-regular text-text-weak py-6 text-center">
                {language.t("settings.worktrees.empty")}
              </div>
            }
          >
            <ul class="flex flex-col gap-1" data-component="settings-worktrees-list">
              <For each={data() ?? []}>
                {(worktree) => {
                  const directory = () => worktree.directory
                  const name = () => worktree.name || basename(worktree.directory)
                  const branch = () => worktree.branch || "-"
                  const blocker = () => boundSessions().get(worktree.directory)
                  const blocked = () => !!blocker()
                  const isConfirming = () => confirming() === worktree.directory
                  const isDeleting = () => deleting() === worktree.directory

                  return (
                    <li class="rounded-md px-2 py-2 transition-colors hover:bg-surface-base-hover">
                      <div class="flex items-start gap-3">
                        <span class="mt-0.5 flex size-5 shrink-0 items-center justify-center text-text-weak">
                          <Icon name="worktree" size="small" />
                        </span>
                        <div class="flex min-w-0 flex-1 flex-col gap-1">
                          <div class="flex min-w-0 items-center gap-2">
                            <span class="truncate text-13-medium text-text-strong" title={directory()}>
                              {name()}
                            </span>
                            <span class="shrink-0 rounded-sm bg-surface-base px-1.5 py-0.5 text-12-regular text-text-weak">
                              {language.t(sourceKey(worktree.source))}
                            </span>
                          </div>
                          <div class="flex min-w-0 items-center gap-1.5 text-12-regular text-text-weak">
                            <span class="shrink-0">{language.t("settings.worktrees.column.branch")}</span>
                            <span class="min-w-0 truncate text-text-strong" title={branch()}>
                              {branch()}
                            </span>
                            <span class="shrink-0 text-text-weaker">/</span>
                            <span class="min-w-0 truncate" title={directory()}>
                              {directory()}
                            </span>
                          </div>
                          <Show when={blocker()}>
                            {(session) => (
                              <div class="text-12-regular text-text-weak">
                                {language.t("settings.worktrees.inUse", { session: session() })}
                              </div>
                            )}
                          </Show>
                        </div>
                        <div class="shrink-0">
                          <Show when={!isConfirming()}>
                            <Button
                              variant="ghost"
                              size="small"
                              disabled={blocked() || isDeleting()}
                              title={
                                blocked()
                                  ? language.t("settings.worktrees.deleteDisabled.tooltip", {
                                      session: blocker() ?? "",
                                    })
                                  : undefined
                              }
                              onClick={() => setConfirming(directory())}
                            >
                              {language.t("settings.worktrees.delete")}
                            </Button>
                          </Show>
                        </div>
                      </div>
                      <Show when={isConfirming()}>
                        <div class="mt-2 flex items-center justify-end gap-2 pl-8">
                          <span class="min-w-0 flex-1 truncate text-13-regular text-text-weak">
                            {language.t("settings.worktrees.confirmDelete.body", { name: name() })}
                          </span>
                          <Button
                            variant="ghost"
                            size="small"
                            disabled={isDeleting()}
                            onClick={() => setConfirming(undefined)}
                          >
                            {language.t("settings.worktrees.confirmDelete.cancelLabel")}
                          </Button>
                          <Button
                            variant="primary"
                            size="small"
                            disabled={isDeleting()}
                            onClick={() => handleDelete(directory())}
                          >
                            {language.t("settings.worktrees.confirmDelete.confirmLabel")}
                          </Button>
                        </div>
                      </Show>
                    </li>
                  )
                }}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </SettingsList>
  )
}
