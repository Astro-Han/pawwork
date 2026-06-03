import { describe, expect, test } from "bun:test"
import { createOpenGlobalConfigFolder } from "./layout-open-global-config"

// These tests exercise the no-toast control flow (config present / absent),
// driving the factory's injected deps. The error branches call the module
// singleton showToast, so they are left to codex review rather than spied
// here (avoids the cross-file mock.module leakage trap, see #1084).

type GetResult = { data?: { config?: string } }

function setup(opts: { get: () => Promise<GetResult> }) {
  const calls = { get: 0, openPath: [] as string[] }
  const open = createOpenGlobalConfigFolder({
    globalSDK: {
      client: {
        path: {
          get: (args: unknown) => {
            calls.get++
            void args
            return opts.get()
          },
        },
      },
    } as unknown as Parameters<typeof createOpenGlobalConfigFolder>[0]["globalSDK"],
    platform: {
      openPath: (target: string) => {
        calls.openPath.push(target)
        return Promise.resolve()
      },
    } as unknown as Parameters<typeof createOpenGlobalConfigFolder>[0]["platform"],
    language: { t: (key: string | number) => String(key) },
  })
  return { open, calls }
}

describe("createOpenGlobalConfigFolder", () => {
  test("opens the resolved config path", async () => {
    const { open, calls } = setup({ get: () => Promise.resolve({ data: { config: "/cfg" } }) })
    await open()
    expect(calls.get).toBe(1)
    expect(calls.openPath).toEqual(["/cfg"])
  })

  test("does nothing when the response carries no config path", async () => {
    const { open, calls } = setup({ get: () => Promise.resolve({ data: {} }) })
    await open()
    expect(calls.get).toBe(1)
    expect(calls.openPath).toEqual([])
  })
})
