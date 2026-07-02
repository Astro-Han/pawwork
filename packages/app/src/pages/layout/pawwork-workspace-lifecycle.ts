import { produce, type SetStoreFunction } from "solid-js/store"
import { showToast, toaster } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { useGlobalSDK } from "@/context/global-sdk"
import type { useGlobalSync } from "@/context/global-sync"
import type { useLayout, LocalProject } from "@/context/layout"
import type { usePlatform } from "@/context/platform"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { clientActionHeaders } from "@/utils/server"
import { effectiveWorkspaceOrder, errorMessage, workspaceKey } from "./helpers"
import { createDefaultLayoutPageState } from "./layout-page-store"

type LayoutPageState = ReturnType<typeof createDefaultLayoutPageState>

export type PawworkWorkspaceLifecycleInput = {
  globalSDK: Pick<ReturnType<typeof useGlobalSDK>, "client" | "createClient">
  globalSync: Pick<ReturnType<typeof useGlobalSync>, "child" | "set">
  layout: Pick<ReturnType<typeof useLayout>, "projects" | "sidebar">
  platform: ReturnType<typeof usePlatform>
  // Injected (not imported) so this controller's module graph stays free of
  // @/context/terminal -> @solidjs/router, which evals client-only templates at
  // import time and breaks the controller's unit test under the server build.
  clearWorkspaceTerminals: typeof import("@/context/terminal").clearWorkspaceTerminals
  store: LayoutPageState
  setStore: SetStoreFunction<LayoutPageState>
  navigate: (href: string) => void
  language: { t: (key: string, params?: Record<string, string | number | boolean>) => string }
  params: { dir?: string }
  setBusy: (directory: string, value: boolean) => void
  currentDir: () => string
  currentProject: () => LocalProject | undefined
  projectRoot: (directory: string) => string
  setWorkspaceName: (directory: string, next: string, projectId?: string, branch?: string) => void
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
}

export function createPawworkWorkspaceLifecycle(input: PawworkWorkspaceLifecycleInput) {
  const renameWorkspace = (directory: string, next: string, projectId?: string, branch?: string) => {
    const current = input.workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)
    if (current === next) return
    input.setWorkspaceName(directory, next, projectId, branch)
  }

  const deleteWorkspace = async (root: string, directory: string, leaveDeletedWorkspace = false) => {
    if (directory === root) return

    const current = input.currentDir()
    const currentKey = workspaceKey(current)
    const deletedKey = workspaceKey(directory)
    const shouldLeave = leaveDeletedWorkspace || (!!input.params.dir && currentKey === deletedKey)
    if (!leaveDeletedWorkspace && shouldLeave) {
      input.navigate(`/${base64Encode(root)}/session`)
    }

    input.setBusy(directory, true)

    const result = await input.globalSDK.client.worktree
      .remove({ directory: root, worktreeRemoveInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: input.language.t("workspace.delete.failed.title"),
          description: errorMessage(err, input.language.t("common.requestFailed")),
        })
        return false
      })

    input.setBusy(directory, false)

    if (!result) return

    input.globalSync.set(
      "project",
      produce((draft) => {
        const project = draft.find((item) => item.worktree === root)
        if (!project) return
        project.sandboxes = (project.sandboxes ?? []).filter((sandbox) => sandbox !== directory)
      }),
    )
    input.setStore("workspaceOrder", root, (order) => (order ?? []).filter((workspace) => workspace !== directory))

    input.layout.projects.close(directory)
    input.layout.projects.open(root)

    if (shouldLeave) return

    const nextCurrent = input.currentDir()
    const nextKey = workspaceKey(nextCurrent)
    const project = input.layout.projects.list().find((item) => item.worktree === root)
    const dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], input.store.workspaceOrder[root])
      : [root]
    const valid = dirs.some((item) => workspaceKey(item) === nextKey)

    if (input.params.dir && input.projectRoot(nextCurrent) === root && !valid) {
      input.navigate(`/${base64Encode(root)}/session`)
    }
  }

  const resetWorkspace = async (root: string, directory: string) => {
    if (directory === root) return
    input.setBusy(directory, true)

    const progress = showToast({
      persistent: true,
      title: input.language.t("workspace.resetting.title"),
      description: input.language.t("workspace.resetting.description"),
    })
    const dismiss = () => toaster.dismiss(progress)

    const sessions: Session[] = await input.globalSDK.client.session
      .list({ directory })
      .then((x) => x.data ?? [])
      .catch(() => [])

    input.clearWorkspaceTerminals(
      directory,
      sessions.map((s) => s.id),
      input.platform,
    )
    const actionClient = input.globalSDK.createClient({
      headers: clientActionHeaders({ kind: "workspace.reset" }),
      throwOnError: true,
    })
    await actionClient.instance.dispose({ directory }).catch(() => undefined)

    const result = await input.globalSDK.client.worktree
      .reset({ directory: root, worktreeResetInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: input.language.t("workspace.reset.failed.title"),
          description: errorMessage(err, input.language.t("common.requestFailed")),
        })
        return false
      })

    if (!result) {
      input.setBusy(directory, false)
      dismiss()
      return
    }

    const archivedAt = Date.now()
    await Promise.all(
      sessions
        .filter((session) => session.time.archived === undefined)
        .map((session) =>
          input.globalSDK.client.session
            .update({
              sessionID: session.id,
              directory: session.directory,
              time: { archived: archivedAt },
            })
            .catch(() => undefined),
        ),
    )

    input.setBusy(directory, false)
    dismiss()

    showToast({
      title: input.language.t("workspace.reset.success.title"),
      description: input.language.t("workspace.reset.success.description"),
      actions: [
        {
          label: input.language.t("command.session.new"),
          onClick: () => {
            const href = `/${base64Encode(directory)}/session`
            input.navigate(href)
          },
        },
        {
          label: input.language.t("common.dismiss"),
          onClick: "dismiss",
        },
      ],
    })
  }

  const createWorkspace = async (project: LocalProject) => {
    const created = await input.globalSDK.client.worktree
      .create({ directory: project.worktree })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: input.language.t("workspace.create.failed.title"),
          description: errorMessage(err, input.language.t("common.requestFailed")),
        })
        return undefined
      })

    if (!created?.directory) return

    input.setWorkspaceName(created.directory, created.branch, project.id, created.branch)

    const local = project.worktree
    const key = workspaceKey(created.directory)
    const root = workspaceKey(local)

    input.setBusy(created.directory, true)
    WorktreeState.pending(created.directory)
    input.setStore("workspaceExpanded", key, true)
    if (key !== created.directory) {
      input.setStore("workspaceExpanded", created.directory, true)
    }
    input.setStore("workspaceOrder", project.worktree, (prev) => {
      const existing = prev ?? []
      const next = existing.filter((item) => {
        const id = workspaceKey(item)
        return id !== root && id !== key
      })
      return [created.directory, ...next]
    })

    input.globalSync.child(created.directory)
    input.navigate(`/${base64Encode(created.directory)}/session`)
  }

  function createCurrentWorkspace() {
    const project = input.currentProject()
    if (!project) return
    return createWorkspace(project)
  }

  function toggleCurrentWorkspace() {
    const project = input.currentProject()
    if (!project) return undefined
    if (project.vcs !== "git") return undefined
    const wasEnabled = input.layout.sidebar.workspaces(project.worktree)()
    input.layout.sidebar.toggleWorkspaces(project.worktree)
    return wasEnabled
  }

  return {
    renameWorkspace,
    deleteWorkspace,
    resetWorkspace,
    createWorkspace,
    createCurrentWorkspace,
    toggleCurrentWorkspace,
  }
}
