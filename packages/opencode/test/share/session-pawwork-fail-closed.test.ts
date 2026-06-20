import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Cause, Layer, Option } from "effect"
import { Instance } from "../../src/project/instance"
import { Session as SessionCore } from "../../src/session"
import { SessionShare } from "../../src/share/session"
import { ShareNext } from "../../src/share/share-next"
import { ShareRuntime } from "../../src/share/runtime"
import { Config } from "../../src/config/config"
import { Log } from "@opencode-ai/core/util/log"
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
const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

// Test layer: rebuilds SessionShare's full default chain except CloudShareGate is swappable.
function sessionShareTestLayer(opts: { gate: { isEnabled: () => boolean } }) {
  const gateLayer = Layer.succeed(ShareRuntime.CloudShareGate, opts.gate)
  return SessionShare.layer.pipe(
    Layer.provide(ShareNext.defaultLayer),
    Layer.provide(SessionNs.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(gateLayer),
  )
}

describe("PawWork runtime cloud share fail-closed", () => {
  test("SessionShare.share fails with typed CloudShareDisabled when gate returns false", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const ses = await SessionNs.create({ title: "fail-closed test" })
        try {
          const disabledLayer = sessionShareTestLayer({ gate: { isEnabled: () => false } })

          const program = SessionShare.Service.use((svc) => svc.share(ses.id))
          const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(disabledLayer)))

          expect(exit._tag).toBe("Failure")
          if (exit._tag !== "Failure") return
          // Cause.findFail returns Result; check .reasons directly.
          const reasons = (exit.cause as unknown as { reasons?: ReadonlyArray<{ error?: unknown }> }).reasons ?? []
          const failed = reasons.find((r) => r.error instanceof ShareRuntime.CloudShareDisabled)
          expect(failed).toBeDefined()
          if (failed) {
            const err = failed.error as ShareRuntime.CloudShareDisabled
            expect(err._tag).toBe("CloudShareDisabled")
          }
        } finally {
          await SessionNs.remove(ses.id)
        }
      },
    })
  })

  test("SessionShare.share succeeds path is preserved when gate returns true", async () => {
    // Sanity: with enabled gate the typed failure must NOT be raised. Actual share publication
    // would hit opncd.ai which we don't want in tests, so we just confirm the gate doesn't
    // short-circuit by verifying the failure (if any) is NOT CloudShareDisabled.
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const ses = await SessionNs.create({ title: "gate-enabled test" })
        try {
          const enabledLayer = sessionShareTestLayer({ gate: { isEnabled: () => true } })

          const program = SessionShare.Service.use((svc) => svc.share(ses.id))
          const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(enabledLayer)))

          // Either succeeds (unlikely without a real cloud account) OR fails for some reason
          // OTHER than CloudShareDisabled. The negative assertion proves the gate is not engaging.
          if (exit._tag === "Failure") {
            const reasons = (exit.cause as unknown as { reasons?: ReadonlyArray<{ error?: unknown }> }).reasons ?? []
            const wronglyDisabled = reasons.find((r) => r.error instanceof ShareRuntime.CloudShareDisabled)
            expect(wronglyDisabled).toBeUndefined()
          }
        } finally {
          await SessionNs.remove(ses.id)
        }
      },
    })
  })
})

// Suppress unused-import warning for Cause/Option which are exported from this test surface
// to make the failure-extraction pattern reusable by other share tests later.
void Cause
void Option
