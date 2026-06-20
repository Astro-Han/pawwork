import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as UI from "../../src/cli/ui"
import { SessionDeleteCommand } from "../../src/cli/cmd/session"
import { Instance } from "../../src/project/instance"
import { Session as SessionCore } from "../../src/session"
import { Log } from "@opencode-ai/core/util/log"
import { tmpdir } from "../fixture/fixture"
import { AppRuntime } from "../../src/effect/app-runtime"


const SessionNs = {
  ...SessionCore,
  create(input?: SessionCore.CreateInput) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.create(input)))
  },
  get(id: Parameters<SessionCore.Interface["get"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.get(id)))
  },
  children(parentID: Parameters<SessionCore.Interface["children"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.children(parentID)))
  },
  fork(input: Parameters<SessionCore.Interface["fork"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.fork(input)))
  },
  remove(id: Parameters<SessionCore.Interface["remove"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.remove(id)))
  },
  setTitle(input: Parameters<SessionCore.Interface["setTitle"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.setTitle(input)))
  },
  setArchived(input: Parameters<SessionCore.Interface["setArchived"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.setArchived(input)))
  },
  setPermission(input: Parameters<SessionCore.Interface["setPermission"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.setPermission(input)))
  },
  messages(input: Parameters<SessionCore.Interface["messages"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.messages(input)))
  },
  messagesPage(input: Parameters<SessionCore.Interface["messagesPage"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.messagesPage(input)))
  },
  removePart(input: Parameters<SessionCore.Interface["removePart"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.removePart(input)))
  },
  updateMessage(input: Parameters<SessionCore.Interface["updateMessage"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.updateMessage(input)))
  },
  updatePart(input: Parameters<SessionCore.Interface["updatePart"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.updatePart(input)))
  },
  updateExecutionContext(input: Parameters<SessionCore.Interface["updateExecutionContext"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.updateExecutionContext(input)))
  },
  findActiveWorktreeBinding(directory: Parameters<SessionCore.Interface["findActiveWorktreeBinding"]>[0]) {
    return AppRuntime.runPromise(SessionCore.Service.use((svc) => svc.findActiveWorktreeBinding(directory)))
  },
}

namespace SessionNs {
  export type Info = SessionCore.Info
  export type Interface = SessionCore.Interface
  export type Service = SessionCore.Service
  export type CreateInput = SessionCore.CreateInput
  export type GlobalInfo = SessionCore.GlobalInfo
}
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
