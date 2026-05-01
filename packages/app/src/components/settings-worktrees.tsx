import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
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

  const projectNameByOwner = createMemo(() => {
    const map = new Map<string, string>()
    for (const project of sync.data.project) {
      map.set(project.worktree, project.name || basename(project.worktree))
    }
    return map
  })

  const ownerName = (ownerDirectory: string) =>
    projectNameByOwner().get(ownerDirectory) || basename(ownerDirectory)

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
      <div class="flex flex-col gap-1 pt-6 pb-2 max-w-[720px]">
        <h2 class="text-16-medium text-text-strong">{language.t("settings.worktrees.title")}</h2>
        <p class="text-13-regular text-text-weak">{language.t("settings.worktrees.description")}</p>
      </div>

      <Show
        when={!data.loading}
        fallback={<div class="text-13-regular text-text-weak py-6 text-center">{language.t("common.loading")}</div>}
      >
        <Show
          when={(data() ?? []).length > 0}
          fallback={
            <div class="flex flex-col items-center gap-2 py-12">
              <Icon name="worktree" size="medium" class="text-text-weaker" />
              <div class="text-13-medium text-text-strong">{language.t("settings.worktrees.empty.title")}</div>
              <div class="text-13-regular text-text-weak">{language.t("settings.worktrees.empty.body")}</div>
            </div>
          }
        >
          <ul class="flex flex-col" data-component="settings-worktrees-list">
            <For each={data() ?? []}>
              {(worktree) => {
                const directory = () => worktree.directory
                const name = () => worktree.name || basename(worktree.directory)
                const branch = () => worktree.branch || ""
                const ownerDir = () => worktree.ownerDirectory
                const owner = () => ownerName(worktree.ownerDirectory)
                const fullId = () => `${owner()} / ${name()}`
                const blocker = () => boundSessions().get(worktree.directory)
                const blocked = () => !!blocker()
                const isConfirming = () => confirming() === worktree.directory
                const isDeleting = () => deleting() === worktree.directory

                return (
                  <li
                    class="flex items-center gap-3 min-h-[72px] py-3 px-2 -mx-2 rounded-md border-b border-border-weak-base last:border-none transition-colors"
                    classList={{
                      "hover:bg-surface-base-hover": !isConfirming(),
                      "bg-surface-warning-weak": isConfirming(),
                    }}
                  >
                    <Show
                      when={!isConfirming()}
                      fallback={
                        <>
                          <Icon name="worktree" size="normal" class="shrink-0 text-text-base" />
                          <div class="flex min-w-0 flex-1 flex-col gap-[2px]">
                            <span class="truncate text-12-regular text-text-weak" title={ownerDir()}>
                              {owner()}
                            </span>
                            <span class="truncate text-13-medium text-text-strong">
                              {language.t("settings.worktrees.confirmDelete.question", { name: name() })}
                            </span>
                            <span class="flex min-w-0 items-center gap-1.5 text-12-regular text-text-weak">
                              <span class="min-w-0 truncate" title={directory()}>
                                {directory()}
                              </span>
                              <span class="shrink-0 text-text-weaker" aria-hidden="true">·</span>
                              <span class="shrink-0">{language.t("settings.worktrees.confirmDelete.warning")}</span>
                            </span>
                          </div>
                          <div class="flex shrink-0 items-center gap-2">
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
                        </>
                      }
                    >
                      <span
                        class="flex shrink-0 items-center"
                        title={language.t(sourceKey(worktree.source))}
                      >
                        <Icon name="worktree" size="normal" class="text-text-weak" />
                      </span>
                      <div class="flex min-w-0 flex-1 flex-col gap-[2px]">
                        <span class="truncate text-12-regular text-text-weak" title={ownerDir()}>
                          {owner()}
                        </span>
                        <span class="truncate text-13-medium text-text-strong" title={fullId()}>
                          {name()}
                        </span>
                        <span class="flex min-w-0 items-center gap-1.5 text-12-regular text-text-weak">
                          <Show when={branch()}>
                            <span class="shrink-0 truncate text-text-base" title={branch()}>
                              {branch()}
                            </span>
                            <span class="shrink-0 text-text-weaker" aria-hidden="true">·</span>
                          </Show>
                          <span class="min-w-0 truncate" title={directory()}>
                            {directory()}
                          </span>
                        </span>
                      </div>
                      <div class="flex shrink-0 items-center">
                        <Show
                          when={blocked()}
                          fallback={
                            <Button
                              variant="ghost"
                              size="small"
                              disabled={isDeleting()}
                              onClick={() => setConfirming(directory())}
                            >
                              {language.t("settings.worktrees.delete")}
                            </Button>
                          }
                        >
                          <span
                            class="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-1 text-12-regular text-text-base"
                            title={language.t("settings.worktrees.deleteDisabled.tooltip", {
                              session: blocker() ?? "",
                            })}
                          >
                            <span
                              class="inline-block h-1.5 w-1.5 rounded-full bg-text-weak"
                              aria-hidden="true"
                            />
                            {language.t("settings.worktrees.inUse.short")}
                          </span>
                        </Show>
                      </div>
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </SettingsList>
  )
}
