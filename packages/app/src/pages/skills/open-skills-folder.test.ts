import { describe, expect, test } from "bun:test"
import { createOpenSkillsFolder } from "./open-skills-folder"

// Exercises the no-toast control flow (skills path present / absent), driving
// the factory's injected deps. Error branches call the module singleton
// showToast, so they are left to review rather than spied here (avoids the
// cross-file mock.module leakage trap, see #1084).

type GetResult = { data?: { skills?: string } }

function setup(opts: { get: () => Promise<GetResult> }) {
  const calls = { get: [] as unknown[], openPath: [] as string[] }
  const open = createOpenSkillsFolder({
    globalSDK: {
      client: {
        path: {
          get: (args: unknown) => {
            calls.get.push(args)
            return opts.get()
          },
        },
      },
    } as unknown as Parameters<typeof createOpenSkillsFolder>[0]["globalSDK"],
    platform: {
      openPath: (target: string) => {
        calls.openPath.push(target)
        return Promise.resolve()
      },
    } as unknown as Parameters<typeof createOpenSkillsFolder>[0]["platform"],
    language: { t: (key: string | number) => String(key) },
  })
  return { open, calls }
}

describe("createOpenSkillsFolder", () => {
  test("ensures and opens the resolved skills path", async () => {
    const { open, calls } = setup({ get: () => Promise.resolve({ data: { skills: "/home/.agents/skills" } }) })
    await open()
    expect(calls.get).toEqual([{ ensureSkills: true }])
    expect(calls.openPath).toEqual(["/home/.agents/skills"])
  })

  test("does nothing when the response carries no skills path", async () => {
    const { open, calls } = setup({ get: () => Promise.resolve({ data: {} }) })
    await open()
    expect(calls.get).toEqual([{ ensureSkills: true }])
    expect(calls.openPath).toEqual([])
  })
})
