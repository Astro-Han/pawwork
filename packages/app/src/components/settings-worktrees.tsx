import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { SettingsList } from "./settings-list"

type WorktreeInfo = {
  name: string
  branch: string
  directory: string
  source?: "created" | "existing"
}

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "")
  const last = trimmed.split(/[/\\]/).pop()
  return last || p
}

/**
 * Settings → Worktrees panel.
 *
 * Lists every PawWork-tracked worktree directory for the current project (via
 * `client.worktree.list()`); offers a per-row delete with two-step confirm. Delete is disabled
 * when an open session in this app instance has the worktree as its activeDirectory; the user
 * must call ExitWorktree from that session first.
 */
export const SettingsWorktrees: Component = () => {
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()

  const [data, { refetch }] = createResource(async () => {
    const res = await sdk.client.worktree.list()
    return (res.data ?? []) as WorktreeInfo[]
  })

  // Sessions whose activeDirectory points at a worktree path block its deletion.
  const boundSessions = (): Map<string, string> => {
    const map = new Map<string, string>()
    const sessions = sync.data.session ?? []
    for (const s of sessions) {
      const exec = s.executionContext
      if (!exec) continue
      if (exec.activeDirectory && exec.activeDirectory !== exec.ownerDirectory) {
        map.set(exec.activeDirectory, s.title)
      }
    }
    return map
  }

  const [confirming, setConfirming] = createSignal<string | undefined>(undefined)
  const [deleting, setDeleting] = createSignal<string | undefined>(undefined)

  const handleDelete = async (directory: string) => {
    setDeleting(directory)
    try {
      const res = await sdk.client.worktree.remove({ worktreeRemoveInput: { directory } })
      if (res.error) throw new Error(JSON.stringify(res.error))
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
      <div class="flex flex-col gap-3 py-4">
        <div class="flex flex-col gap-1">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.worktrees.title")}</h2>
          <p class="text-13-regular text-text-weak">{language.t("settings.worktrees.description")}</p>
        </div>

        <Show
          when={!data.loading}
          fallback={
            <div class="text-13-regular text-text-weak py-6 text-center">{language.t("common.loading")}</div>
          }
        >
          <Show
            when={(data() ?? []).length > 0}
            fallback={
              <div class="text-13-regular text-text-weak py-6 text-center">
                {language.t("settings.worktrees.empty")}
              </div>
            }
          >
            <ul
              class="flex flex-col divide-y divide-line-base rounded border border-line-base"
              data-component="settings-worktrees-list"
            >
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
                    <li class="flex items-center gap-3 px-3 py-2.5">
                      <Icon name="worktree" size="small" class="text-text-weak shrink-0" />
                      <div class="flex flex-col min-w-0 flex-1">
                        <span class="text-13-medium text-text-strong truncate" title={directory()}>
                          {name()}
                        </span>
                        <span class="text-13-regular text-text-weak truncate" title={directory()}>
                          {branch()} · {worktree.source ?? "created"} · {directory()}
                        </span>
                      </div>
                      <Show
                        when={isConfirming()}
                        fallback={
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
                        }
                      >
                        <div class="flex items-center gap-1">
                          <span class="text-13-regular text-text-weak">
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
