import { createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { getFilename } from "@opencode-ai/util/path"
import { base64Encode } from "@opencode-ai/util/encode"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import type { useGlobalSDK } from "@/context/global-sdk"
import type { useDialog } from "@opencode-ai/ui/context/dialog"
import { workspaceKey } from "./helpers"

export type WorkspaceDialogsInput = {
  globalSDK: Pick<ReturnType<typeof useGlobalSDK>, "client">
  dialog: Pick<ReturnType<typeof useDialog>, "close">
  language: { t: (key: string, params?: Record<string, string | number | boolean>) => string }
  params: { dir?: string }
  currentDir: () => string
  navigate: (href: string) => void
  deleteWorkspace: (root: string, directory: string, leaveDeletedWorkspace?: boolean) => unknown
  resetWorkspace: (root: string, directory: string) => unknown
}

export function createWorkspaceDialogs(input: WorkspaceDialogsInput) {
  function DialogDeleteWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [data, setData] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
    })

    onMount(() => {
      input.globalSDK.client.file
        .status({ directory: props.directory })
        .then((x) => {
          const files = x.data ?? []
          const dirty = files.length > 0
          setData({ status: "ready", dirty })
        })
        .catch(() => {
          setData({ status: "error", dirty: false })
        })
    })

    const handleDelete = () => {
      const leaveDeletedWorkspace = !!input.params.dir && workspaceKey(input.currentDir()) === workspaceKey(props.directory)
      if (leaveDeletedWorkspace) {
        input.navigate(`/${base64Encode(props.root)}/session`)
      }
      input.dialog.close()
      void input.deleteWorkspace(props.root, props.directory, leaveDeletedWorkspace)
    }

    const description = () => {
      if (data.status === "loading") return input.language.t("workspace.status.checking")
      if (data.status === "error") return input.language.t("workspace.status.error")
      if (!data.dirty) return input.language.t("workspace.status.clean")
      return input.language.t("workspace.status.dirty")
    }

    return (
      <Dialog title={input.language.t("workspace.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-body text-fg-strong">
              {input.language.t("workspace.delete.confirm", { name: name() })}
            </span>
            <span class="text-body text-fg-weak">{description()}</span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => input.dialog.close()}>
              {input.language.t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={data.status === "loading"} onClick={handleDelete}>
              {input.language.t("workspace.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogResetWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [state, setState] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
      sessions: [] as Session[],
    })

    const refresh = async () => {
      const sessions = await input.globalSDK.client.session
        .list({ directory: props.directory })
        .then((x) => x.data ?? [])
        .catch(() => [])
      const active = sessions.filter((session) => session.time.archived === undefined)
      setState({ sessions: active })
    }

    onMount(() => {
      input.globalSDK.client.file
        .status({ directory: props.directory })
        .then((x) => {
          const files = x.data ?? []
          const dirty = files.length > 0
          setState({ status: "ready", dirty })
          void refresh()
        })
        .catch(() => {
          setState({ status: "error", dirty: false })
        })
    })

    const handleReset = () => {
      input.dialog.close()
      void input.resetWorkspace(props.root, props.directory)
    }

    const archivedCount = () => state.sessions.length

    const description = () => {
      if (state.status === "loading") return input.language.t("workspace.status.checking")
      if (state.status === "error") return input.language.t("workspace.status.error")
      if (!state.dirty) return input.language.t("workspace.status.clean")
      return input.language.t("workspace.status.dirty")
    }

    const archivedLabel = () => {
      const count = archivedCount()
      if (count === 0) return input.language.t("workspace.reset.archived.none")
      if (count === 1) return input.language.t("workspace.reset.archived.one")
      return input.language.t("workspace.reset.archived.many", { count })
    }

    return (
      <Dialog title={input.language.t("workspace.reset.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-body text-fg-strong">
              {input.language.t("workspace.reset.confirm", { name: name() })}
            </span>
            <span class="text-body text-fg-weak">
              {description()} {archivedLabel()} {input.language.t("workspace.reset.note")}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => input.dialog.close()}>
              {input.language.t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={state.status === "loading"} onClick={handleReset}>
              {input.language.t("workspace.reset.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  return { DialogDeleteWorkspace, DialogResetWorkspace }
}
