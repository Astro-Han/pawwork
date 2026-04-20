/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, mock, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import { onMount } from "solid-js"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { RouteProvider } from "../../../src/cli/cmd/tui/context/route"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { SyncProvider } from "../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { KeybindProvider } from "../../../src/cli/cmd/tui/context/keybind"
import { DialogProvider, useDialog } from "../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider, useToast } from "../../../src/cli/cmd/tui/ui/toast"

const sighup = new Set(process.listeners("SIGHUP"))

afterEach(() => {
  for (const fn of process.listeners("SIGHUP")) {
    if (!sighup.has(fn)) process.off("SIGHUP", fn)
  }
})

type SessionRow = {
  id: string
  title: string
  workspaceID?: string
  parentID?: string
  time: {
    created: number
    updated: number
  }
}

type CapturedDialogSelectProps = {
  options: {
    title: string
    value: string
  }[]
  keybind?: {
    title: string
    onTrigger: (option: {
      title: string
      value: string
    }) => void | Promise<void>
  }[]
}

let capturedDialogSelectProps: CapturedDialogSelectProps | undefined

mock.module("../../../src/cli/cmd/tui/ui/dialog-select", () => ({
  DialogSelect(props: CapturedDialogSelectProps) {
    capturedDialogSelectProps = props
    return <box />
  },
}))

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json",
    },
    ...init,
  })
}

function emptySource() {
  return {
    subscribe: async () => () => {},
  }
}

async function wait(
  fn: () => boolean,
  renderOnce: () => Promise<void>,
  timeout = 2000,
) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await renderOnce()
    await Bun.sleep(10)
  }
}

function createFetch(input: {
  sessions: SessionRow[]
  workspaces?: { id: string; name?: string; type?: string }[]
  workspaceStatus?: Record<string, "connected" | "connecting" | "disconnected" | "error">
  sessionDelete?: (sessionID: string) => Response | Promise<Response>
}) {
  return Object.assign(
    async (reqInput: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(reqInput, init)
      const url = new URL(req.url)
      const path = url.pathname

      if (path === "/config/providers") return json({ providers: [], default: {} })
      if (path === "/provider") return json({ all: [], default: {}, connected: [] })
      if (path === "/experimental/console") return json({})
      if (path === "/agent") return json([])
      if (path === "/config") return json({})
      if (path === "/project/current") return json({ id: "proj_root" })
      if (path === "/path") {
        return json({
          state: "/tmp/root/state",
          config: "/tmp/root/config",
          worktree: "/tmp/worktree",
          directory: "/tmp/root",
          home: "/tmp/root",
        })
      }
      if (path === "/session" && req.method === "GET") return json(input.sessions)
      if (path === "/command") return json([])
      if (path === "/lsp") return json([])
      if (path === "/mcp") return json({})
      if (path === "/experimental/resource") return json({})
      if (path === "/formatter") return json([])
      if (path === "/session/status") return json({})
      if (path === "/provider/auth") return json({})
      if (path === "/vcs") return json({ branch: "main" })
      if (path === "/experimental/workspace") {
        return json(
          (input.workspaces ?? []).map((item) => ({
            id: item.id,
            name: item.name ?? item.id,
            type: item.type ?? "local",
          })),
        )
      }
      if (path === "/experimental/workspace/status") {
        return json(
          Object.entries(input.workspaceStatus ?? {}).map(([workspaceID, status]) => ({
            workspaceID,
            status,
          })),
        )
      }
      if (path.startsWith("/session/") && req.method === "DELETE") {
        const sessionID = path.split("/").at(-1)!
        return input.sessionDelete?.(sessionID) ?? json({}, { status: 204 })
      }

      throw new Error(`unexpected request: ${req.method} ${path}`)
    },
    { preconnect: fetch.preconnect.bind(fetch) },
  ) satisfies typeof fetch
}

async function mount(input: {
  sessions: SessionRow[]
  workspaces?: { id: string; name?: string; type?: string }[]
  workspaceStatus?: Record<string, "connected" | "connecting" | "disconnected" | "error">
  sessionDelete?: (sessionID: string) => Response | Promise<Response>
}) {
  const { DialogSessionList } = await import("../../../src/cli/cmd/tui/component/dialog-session-list")

  let dialog!: ReturnType<typeof useDialog>
  let toast!: ReturnType<typeof useToast>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  capturedDialogSelectProps = undefined

  const app = await testRender(() => (
    <ArgsProvider continue={false}>
      <ExitProvider onExit={async () => {}}>
        <KVProvider>
          <ToastProvider>
            <RouteProvider>
              <TuiConfigProvider
                config={
                  {
                    keybinds: {
                      session_delete: "f2",
                    },
                  } as any
                }
              >
                <SDKProvider
                  url="http://test"
                  directory="/tmp/root"
                  fetch={createFetch(input)}
                  events={emptySource()}
                >
                  <ProjectProvider>
                    <SyncProvider>
                      <ThemeProvider mode="dark">
                        <KeybindProvider>
                          <DialogProvider>
                            <Probe
                              onReady={(ctx) => {
                                dialog = ctx.dialog
                                toast = ctx.toast
                                done()
                              }}
                            />
                            <DialogSessionList />
                          </DialogProvider>
                        </KeybindProvider>
                      </ThemeProvider>
                    </SyncProvider>
                  </ProjectProvider>
                </SDKProvider>
              </TuiConfigProvider>
            </RouteProvider>
          </ToastProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  ))

  await ready
  await wait(() => capturedDialogSelectProps !== undefined, app.renderOnce)

  return {
    ...app,
    dialog,
    toast,
    get select() {
      if (!capturedDialogSelectProps) throw new Error("DialogSelect props not captured")
      return capturedDialogSelectProps
    },
  }
}

function Probe(props: { onReady: (ctx: { dialog: ReturnType<typeof useDialog>; toast: ReturnType<typeof useToast> }) => void }) {
  const dialog = useDialog()
  const toast = useToast()

  onMount(() => {
    props.onReady({ dialog, toast })
  })
  return <box />
}

describe("DialogSessionList", () => {
  test("orders sessions by most recently updated, not most recently created within the day", async () => {
    const now = Date.now()
    const app = await mount({
      sessions: [
        {
          id: "ses_old_create",
          title: "older-update-newer-create",
          time: {
            updated: now - 60 * 60 * 1000,
            created: now - 1,
          },
        },
        {
          id: "ses_fresh_update",
          title: "newer-update-older-create",
          time: {
            updated: now,
            created: now - 2 * 60 * 60 * 1000,
          },
        },
      ],
    })

    try {
      expect(app.select.options.map((item) => item.title)).toEqual([
        "newer-update-older-create",
        "older-update-newer-create",
      ])
    } finally {
      app.renderer.destroy()
    }
  })

  test("shows a delete-session toast and never opens recovery UI when workspace session deletion fails", async () => {
    const app = await mount({
      sessions: [
        {
          id: "ses_1",
          title: "connected-workspace-session",
          workspaceID: "ws_a",
          time: {
            updated: Date.now(),
            created: Date.now() - 1000,
          },
        },
      ],
      workspaces: [{ id: "ws_a", name: "Workspace A", type: "git" }],
      workspaceStatus: { ws_a: "error" },
      sessionDelete: () =>
        json(
          {
            message: "boom",
          },
          { status: 500 },
        ),
    })

    try {
      const option = app.select.options[0]
      const deleteKey = app.select.keybind?.find((item) => item.title === "delete")
      if (!option || !deleteKey) throw new Error("delete action not captured")

      await deleteKey.onTrigger(option)
      await wait(
        () => app.select.options[0]?.title.includes("again to confirm") === true,
        app.renderOnce,
      )

      await deleteKey.onTrigger(app.select.options[0]!)

      await wait(() => !!app.toast.currentToast, app.renderOnce)

      expect(app.toast.currentToast?.title).toBe("Failed to delete session")
      expect(app.dialog.stack).toHaveLength(0)
    } finally {
      app.renderer.destroy()
    }
  })
})
