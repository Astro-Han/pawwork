import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { SettingsList } from "./settings-list"
import { SettingsWorktreeRow } from "./settings-worktree-row"
import { basename, errorText, type BoundSession, type WorktreeInfo } from "./settings-worktrees-helpers"

export const SettingsWorktrees: Component = () => {
  const language = useLanguage()
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const navigate = useNavigate()

  const projectRoots = () =>
    sync.data.project
      .filter((project) => project.vcs === "git")
      .map((project) => project.worktree)
      .filter(Boolean)

  const [data, { refetch }] = createResource(
    () => projectRoots().join("\0"),
    async () => {
      const results = await Promise.allSettled(
        projectRoots().map(async (ownerDirectory) => {
          const res = await sdk.client.worktree.list({ directory: ownerDirectory })
          if (res.error) throw new Error(errorText(res.error))
          return (res.data ?? []).map((worktree) => ({ ...worktree, ownerDirectory }) as WorktreeInfo)
        }),
      )
      const rows = results
        .filter((result): result is PromiseFulfilledResult<WorktreeInfo[]> => result.status === "fulfilled")
        .map((result) => result.value)
      if (rows.length === 0 && results.some((result) => result.status === "rejected")) {
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
        throw new Error(errorText(failed?.reason))
      }
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

  const ownerName = (ownerDirectory: string) => projectNameByOwner().get(ownerDirectory) || basename(ownerDirectory)

  const boundSessions = createMemo((): Map<string, BoundSession> => {
    const map = new Map<string, BoundSession>()
    const directories = new Set<string>()
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
          map.set(exec.activeDirectory, {
            id: s.id,
            title: s.title,
            hostDirectory: directory,
          })
        }
      }
    }
    return map
  })

  const openSession = (entry: BoundSession) => {
    navigate(`/${base64Encode(entry.hostDirectory)}/session/${entry.id}`)
  }

  const [confirming, setConfirming] = createSignal<string | undefined>(undefined)
  const [deleting, setDeleting] = createSignal<Set<string>>(new Set())

  const handleDelete = async (directory: string) => {
    if (deleting().has(directory)) return
    setDeleting((current) => new Set(current).add(directory))
    try {
      const ownerDirectory = data()?.find((worktree) => worktree.directory === directory)?.ownerDirectory ?? directory
      const res = await sdk.client.worktree.remove({ directory: ownerDirectory, worktreeRemoveInput: { directory } })
      if (res.error) throw new Error(errorText(res.error))
      setConfirming((current) => (current === directory ? undefined : current))
      void refetch()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({
        title: language.t("settings.worktrees.deleteFailed", { message }),
      })
    } finally {
      setDeleting((current) => {
        const next = new Set(current)
        next.delete(directory)
        return next
      })
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
          when={!data.error}
          fallback={
            <div class="flex flex-col items-center gap-2 py-12">
              <div class="text-13-medium text-text-strong">{language.t("common.requestFailed")}</div>
              <div class="text-13-regular text-text-weak">{errorText(data.error)}</div>
            </div>
          }
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
                {(worktree) => (
                  <SettingsWorktreeRow
                    worktree={worktree}
                    ownerName={ownerName(worktree.ownerDirectory)}
                    boundSession={boundSessions().get(worktree.directory)}
                    confirming={confirming() === worktree.directory}
                    deleting={deleting().has(worktree.directory)}
                    onCancelDelete={() => setConfirming(undefined)}
                    onConfirmDelete={handleDelete}
                    onRequestDelete={setConfirming}
                    onOpenSession={openSession}
                  />
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </SettingsList>
  )
}
