import { describe, expect, test } from "bun:test"
import { createTerminalLifecycle } from "./terminal-lifecycle"
import { runtimePTYID, terminalTabID } from "./terminal-types"

describe("createTerminalLifecycle", () => {
  test("coalesces concurrent ensureLive calls for a durable tab", async () => {
    const creates: string[] = []
    const lifecycle = createTerminalLifecycle({
      create: async ({ title }) => {
        creates.push(title)
        return { ptyID: runtimePTYID("pty_runtime"), title }
      },
      remove: async () => undefined,
    })

    const tabID = terminalTabID("tab_one")
    const [first, second] = await Promise.all([
      lifecycle.ensureLive({ tabID, title: "Terminal 1" }),
      lifecycle.ensureLive({ tabID, title: "Terminal 1" }),
    ])

    expect(creates).toEqual(["Terminal 1"])
    expect(first?.ptyID).toBe(runtimePTYID("pty_runtime"))
    expect(second).toBe(first)
    expect(first?.ptyID).not.toBe(tabID)
  })

  test("does not revive a closed tab when create resolves late", async () => {
    let resolveCreate: ((value: { ptyID: ReturnType<typeof runtimePTYID>; title: string }) => void) | undefined
    const removed: string[] = []
    const lifecycle = createTerminalLifecycle({
      create: ({ title }) =>
        new Promise<{ ptyID: ReturnType<typeof runtimePTYID>; title: string }>((resolve) => {
          resolveCreate = resolve
        }).then((value) => ({ ...value, title })),
      remove: async (ptyID) => {
        removed.push(ptyID)
      },
    })

    const tabID = terminalTabID("tab_slow")
    const pending = lifecycle.ensureLive({ tabID, title: "Terminal 2" })
    lifecycle.removeRuntime(tabID)
    resolveCreate?.({ ptyID: runtimePTYID("pty_late"), title: "Terminal 2" })

    await expect(pending).resolves.toBeUndefined()
    expect(lifecycle.peek(tabID)).toBeUndefined()
    expect(removed).toEqual(["pty_late"])
  })

  test("invalidates runtime entries without deleting durable tabs", async () => {
    const removed: string[] = []
    const lifecycle = createTerminalLifecycle({
      create: async ({ title }) => ({ ptyID: runtimePTYID(`pty_${title}`), title }),
      remove: async (ptyID) => {
        removed.push(ptyID)
      },
    })
    const tabID = terminalTabID("tab_keep")

    await lifecycle.ensureLive({ tabID, title: "keep" })
    expect(lifecycle.peek(tabID)?.ptyID).toBe(runtimePTYID("pty_keep"))

    lifecycle.clearRuntime()

    expect(lifecycle.peek(tabID)).toBeUndefined()
    expect(removed).toEqual(["pty_keep"])
  })
})
