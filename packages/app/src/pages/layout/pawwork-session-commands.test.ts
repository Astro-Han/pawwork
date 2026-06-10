import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { toaster } from "@opencode-ai/ui/toast"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { createPawworkSessionCommands, type PawworkSessionCommandsInput } from "./pawwork-session-commands"

// showToast renders through the module-singleton toaster.show (not injected);
// spy it to count toasts. The render closure is never invoked, so no JSX runs.
async function withToastSpy(fn: (shown: unknown[]) => Promise<void>) {
  const shown: unknown[] = []
  const original = toaster.show
  toaster.show = ((render: unknown) => {
    shown.push(render)
    return "toast-id"
  }) as unknown as typeof toaster.show
  try {
    await fn(shown)
  } finally {
    toaster.show = original
  }
}

type SetupOpts = {
  sessions?: unknown[]
  updateReject?: boolean
  deleteReject?: boolean
  deleteResult?: unknown
  exportSession?: PawworkSessionCommandsInput["platform"]["exportSession"]
  exportResult?: { ok: true; path: string } | { ok: false; error: string }
  exportThrow?: boolean
  serverCurrent?: { type: string } | undefined
  paramsId?: string
  paramsDir?: string
}

function setup(opts: SetupOpts = {}) {
  const calls = {
    sessionUpdate: [] as unknown[],
    sessionDelete: [] as unknown[],
    child: [] as string[],
    navigate: [] as string[],
    exportArgs: [] as unknown[][],
  }
  const [childStore, setChildStore] = createStore<{
    session: unknown[]
    session_status: Record<string, unknown>
    turn_change_aggregate: Record<string, unknown>
    todo: Record<string, unknown>
    message: Record<string, unknown>
    part: Record<string, unknown>
    permission: Record<string, unknown>
  }>({
    session: opts.sessions ?? [],
    session_status: {},
    turn_change_aggregate: {},
    todo: {},
    message: {},
    part: {},
    permission: {},
  })
  const defaultExport = ((id: string, dir: string, name: string, label: string) => {
    calls.exportArgs.push([id, dir, name, label])
    if (opts.exportThrow) return Promise.reject(new Error("export crashed"))
    return Promise.resolve(opts.exportResult ?? { ok: true, path: "/out/file.json" })
  }) as unknown as PawworkSessionCommandsInput["platform"]["exportSession"]
  // Distinguish "explicitly no bridge" (exportSession: undefined) from "default".
  const exportSession = "exportSession" in opts ? opts.exportSession : defaultExport
  const input = {
    globalSDK: {
      client: {
        session: {
          update: (args: unknown) => {
            calls.sessionUpdate.push(args)
            if (opts.updateReject) return Promise.reject(new Error("update failed"))
            return Promise.resolve({ data: {} })
          },
          delete: (args: unknown) => {
            calls.sessionDelete.push(args)
            if (opts.deleteReject) return Promise.reject(new Error("delete failed"))
            return Promise.resolve({ data: opts.deleteResult ?? { ok: true } })
          },
        },
      },
    },
    globalSync: {
      child: (directory: string) => {
        calls.child.push(directory)
        return [childStore, setChildStore] as never
      },
    },
    platform: { exportSession },
    server: { current: opts.serverCurrent },
    language: { t: (key: string) => key },
    navigate: (href: string) => calls.navigate.push(href),
    params: { id: opts.paramsId, dir: opts.paramsDir },
  } as unknown as PawworkSessionCommandsInput
  return { input, calls, childStore }
}

const makeSession = (over: Record<string, unknown> = {}) =>
  ({ id: "s1", directory: "/repo", title: "old", ...over }) as unknown as Session

describe("createPawworkSessionCommands", () => {
  test("renamePawworkSession skips the write for an empty or unchanged title", async () => {
    await withToastSpy(async (shown) => {
      await createRoot(async (dispose) => {
        const { input, calls } = setup()
        const cmd = createPawworkSessionCommands(input)
        await cmd.renamePawworkSession(makeSession({ title: "kept" }), "   ")
        await cmd.renamePawworkSession(makeSession({ title: "kept" }), "kept")
        expect(calls.sessionUpdate).toEqual([])
        expect(shown.length).toBe(0)
        dispose()
      })
    })
  })

  test("renamePawworkSession updates the server and the child store title", async () => {
    await withToastSpy(async (shown) => {
      await createRoot(async (dispose) => {
        const { input, calls, childStore } = setup({
          sessions: [{ id: "s1", title: "old" }],
        })
        const cmd = createPawworkSessionCommands(input)
        await cmd.renamePawworkSession(makeSession({ id: "s1", directory: "/repo", title: "old" }), "  fresh  ")
        expect(calls.sessionUpdate).toEqual([{ directory: "/repo", sessionID: "s1", title: "fresh" }])
        expect((childStore.session[0] as { title: string }).title).toBe("fresh")
        expect(shown.length).toBe(0)
        dispose()
      })
    })
  })

  test("renamePawworkSession surfaces a toast and leaves the store on failure", async () => {
    await withToastSpy(async (shown) => {
      await createRoot(async (dispose) => {
        const { input, childStore } = setup({
          sessions: [{ id: "s1", title: "old" }],
          updateReject: true,
        })
        const cmd = createPawworkSessionCommands(input)
        await cmd.renamePawworkSession(makeSession({ id: "s1", title: "old" }), "fresh")
        expect((childStore.session[0] as { title: string }).title).toBe("old")
        expect(shown.length).toBe(1)
        dispose()
      })
    })
  })

  test("exportSessionAvailable no longer exposes raw session JSON export", () => {
    createRoot((dispose) => {
      const sidecar = setup({ exportSession: (() => Promise.resolve({ ok: true, path: "" })) as never, serverCurrent: { type: "sidecar" } })
      expect(createPawworkSessionCommands(sidecar.input).exportSessionAvailable()).toBe(false)

      const remote = setup({ exportSession: (() => Promise.resolve({ ok: true, path: "" })) as never, serverCurrent: { type: "remote" } })
      expect(createPawworkSessionCommands(remote.input).exportSessionAvailable()).toBe(false)

      const noExport = setup({ exportSession: undefined, serverCurrent: { type: "sidecar" } })
      expect(createPawworkSessionCommands(noExport.input).exportSessionAvailable()).toBe(false)
      dispose()
    })
  })

  test("exportSession is a no-op without a platform export bridge", async () => {
    await withToastSpy(async (shown) => {
      await createRoot(async (dispose) => {
        const { input, calls } = setup({ exportSession: undefined })
        const cmd = createPawworkSessionCommands(input)
        await cmd.exportSession(makeSession())
        expect(calls.exportArgs).toEqual([])
        expect(shown.length).toBe(0)
        dispose()
      })
    })
  })

  test("exportSession builds a slug filename and toasts the path on success", async () => {
    await withToastSpy(async (shown) => {
      await createRoot(async (dispose) => {
        const { input, calls } = setup({
          sessions: [{ id: "s1", slug: "hello-world" }],
          exportResult: { ok: true, path: "/out/done.json" },
        })
        const cmd = createPawworkSessionCommands(input)
        await cmd.exportSession(makeSession({ id: "s1" }))
        const defaultName = calls.exportArgs[0][2] as string
        expect(defaultName.startsWith("pawwork-session-hello-world-")).toBe(true)
        expect(defaultName.endsWith(".json")).toBe(true)
        expect(shown.length).toBe(1)
        dispose()
      })
    })
  })

  test("exportSession sanitizes filesystem-hostile slug characters", async () => {
    await withToastSpy(async () => {
      await createRoot(async (dispose) => {
        const { input, calls } = setup({
          sessions: [{ id: "s1", slug: 'a/b:c*?"<>|d' }],
        })
        const cmd = createPawworkSessionCommands(input)
        await cmd.exportSession(makeSession({ id: "s1" }))
        const defaultName = calls.exportArgs[0][2] as string
        expect(defaultName.startsWith("pawwork-session-a-b-c------d-")).toBe(true)
        dispose()
      })
    })
  })

  test("exportSession falls back to the session id suffix when the slug has no alphanumerics", async () => {
    await withToastSpy(async () => {
      await createRoot(async (dispose) => {
        const { input, calls } = setup({
          sessions: [{ id: "sess_abcd1234", slug: "***" }],
        })
        const cmd = createPawworkSessionCommands(input)
        await cmd.exportSession(makeSession({ id: "sess_abcd1234" }))
        const defaultName = calls.exportArgs[0][2] as string
        expect(defaultName.includes("abcd1234")).toBe(true)
        dispose()
      })
    })
  })

  test("exportSession stays silent when the user cancels", async () => {
    await withToastSpy(async (shown) => {
      await createRoot(async (dispose) => {
        const { input } = setup({
          sessions: [{ id: "s1", slug: "hi" }],
          exportResult: { ok: false, error: "cancelled" },
        })
        const cmd = createPawworkSessionCommands(input)
        await cmd.exportSession(makeSession({ id: "s1" }))
        expect(shown.length).toBe(0)
        dispose()
      })
    })
  })

  test("exportSession toasts on a thrown bridge error and on a non-cancel failure", async () => {
    await withToastSpy(async (shown) => {
      await createRoot(async (dispose) => {
        const thrown = setup({ sessions: [{ id: "s1", slug: "hi" }], exportThrow: true })
        await createPawworkSessionCommands(thrown.input).exportSession(makeSession({ id: "s1" }))
        const failed = setup({ sessions: [{ id: "s1", slug: "hi" }], exportResult: { ok: false, error: "disk full" } })
        await createPawworkSessionCommands(failed.input).exportSession(makeSession({ id: "s1" }))
        expect(shown.length).toBe(2)
        dispose()
      })
    })
  })

  test("deleteSession cascades to descendants, drops them from the store, and navigates the active route", async () => {
    await withToastSpy(async (shown) => {
      await createRoot(async (dispose) => {
        const { input, calls, childStore } = setup({
          sessions: [
            { id: "p", directory: "/repo", parentID: undefined, time: {} },
            { id: "c1", directory: "/repo", parentID: "p", time: {} },
            { id: "c2", directory: "/repo", parentID: "c1", time: {} },
            { id: "keep", directory: "/repo", parentID: undefined, time: {} },
          ],
          paramsId: "p",
          paramsDir: "dirslug",
        })
        const cmd = createPawworkSessionCommands(input)
        await cmd.deleteSession({ id: "p", directory: "/repo" })

        expect(calls.sessionDelete).toEqual([{ directory: "/repo", sessionID: "p" }])
        const remaining = (childStore.session as { id: string }[]).map((s) => s.id)
        expect(remaining).toEqual(["keep"])
        // p was the active session and is the first top-level; next is "keep".
        expect(calls.navigate).toEqual(["/dirslug/session/keep"])
        expect(shown.length).toBe(0)
        dispose()
      })
    })
  })

  test("deleteSession does not navigate when the deleted session is not the active one", async () => {
    await withToastSpy(async () => {
      await createRoot(async (dispose) => {
        const { input, calls } = setup({
          sessions: [
            { id: "p", directory: "/repo", parentID: undefined, time: {} },
            { id: "other", directory: "/repo", parentID: undefined, time: {} },
          ],
          paramsId: "other",
          paramsDir: "dirslug",
        })
        const cmd = createPawworkSessionCommands(input)
        await cmd.deleteSession({ id: "p", directory: "/repo" })
        expect(calls.navigate).toEqual([])
        dispose()
      })
    })
  })

  test("deleteSession navigates to the previous sibling when the deleted session is last, skipping archived ones", async () => {
    await withToastSpy(async () => {
      await createRoot(async (dispose) => {
        const { input, calls } = setup({
          sessions: [
            { id: "a", directory: "/repo", parentID: undefined, time: {} },
            { id: "b", directory: "/repo", parentID: undefined, time: {} },
            { id: "arch", directory: "/repo", parentID: undefined, time: { archived: 123 } },
          ],
          paramsId: "b",
          paramsDir: "dirslug",
        })
        const cmd = createPawworkSessionCommands(input)
        await cmd.deleteSession({ id: "b", directory: "/repo" })
        // "b" is the last non-archived top-level; next falls back to the prior
        // sibling "a" (archived "arch" is excluded from the candidate list).
        expect(calls.navigate).toEqual(["/dirslug/session/a"])
        dispose()
      })
    })
  })

  test("deleteSession falls back to the bare session route when no sibling remains", async () => {
    await withToastSpy(async () => {
      await createRoot(async (dispose) => {
        const { input, calls } = setup({
          sessions: [{ id: "only", directory: "/repo", parentID: undefined, time: {} }],
          paramsId: "only",
          paramsDir: "dirslug",
        })
        const cmd = createPawworkSessionCommands(input)
        await cmd.deleteSession({ id: "only", directory: "/repo" })
        expect(calls.navigate).toEqual(["/dirslug/session"])
        dispose()
      })
    })
  })

  test("deleteSession toasts and leaves the store untouched when the request fails", async () => {
    await withToastSpy(async (shown) => {
      await createRoot(async (dispose) => {
        const { input, calls, childStore } = setup({
          sessions: [{ id: "p", directory: "/repo", parentID: undefined, time: {} }],
          paramsId: "p",
          paramsDir: "dirslug",
          deleteReject: true,
        })
        const cmd = createPawworkSessionCommands(input)
        await cmd.deleteSession({ id: "p", directory: "/repo" })
        expect((childStore.session as { id: string }[]).map((s) => s.id)).toEqual(["p"])
        expect(calls.navigate).toEqual([])
        expect(shown.length).toBe(1)
        dispose()
      })
    })
  })
})
