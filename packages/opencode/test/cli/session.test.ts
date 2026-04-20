import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as UI from "../../src/cli/ui"
import { SessionDeleteCommand } from "../../src/cli/cmd/session"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const originalCwd = process.cwd()

afterEach(async () => {
  mock.restore()
  process.chdir(originalCwd)
  await Instance.disposeAll()
})

describe("cli session delete", () => {
  test("session delete removes an existing session and exits successfully", async () => {
    await using tmp = await tmpdir({ git: true })
    const session = await Instance.provide({
      directory: tmp.path,
      fn: () => SessionNs.create({ title: "delete-me" }),
    })

    const lines: string[] = []
    const printSpy = spyOn(UI, "println").mockImplementation((...message: string[]) => {
      lines.push(message.join(" "))
    })

    process.chdir(tmp.path)
    await (SessionDeleteCommand.handler as (args: { sessionID: string }) => Promise<void>)({
      sessionID: session.id,
    })

    let missing = false
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        SessionNs.get(session.id).catch(() => {
          missing = true
          return undefined as any
        }),
    })

    expect(missing).toBe(true)
    expect(printSpy).toHaveBeenCalled()
    expect(lines.join("\n")).toContain(`Session ${session.id} deleted`)
  })
})
