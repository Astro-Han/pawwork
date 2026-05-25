import { InstanceState } from "@/effect/instance-state"
import { Runner, type InterruptMeta } from "@/effect/runner"
import { Deferred, Effect, Layer, Scope, Context } from "effect"
import { Instance } from "@/project/instance"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { currentLifecycleCloseAction, lifecycleCloseActionMeta, trackActiveRun } from "./lifecycle-provenance"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID, meta?: InterruptMeta) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: (meta?: InterruptMeta) => Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    options?: { rejectIfBusy?: boolean },
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: (meta?: InterruptMeta) => Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Deferred.Deferred<void>,
  ) => Effect.Effect<MessageV2.WithParts>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner<MessageV2.WithParts>>()
        let scopeCloseAction = currentLifecycleCloseAction(ctx.directory)
        const lifecycleAction = () => currentLifecycleCloseAction(ctx.directory)
        const interruptFallback = () => {
          const action = lifecycleAction() ?? scopeCloseAction
          return {
            source: "session.run_state.scope",
            reason: "scope_closed_without_cancel_meta",
            ...(action ? lifecycleCloseActionMeta(action) : {}),
          } satisfies InterruptMeta
        }
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            const action = lifecycleAction()
            scopeCloseAction = action ?? scopeCloseAction
            yield* Effect.forEach(
              runners.values(),
              (runner) =>
                runner.cancelWith({
                  source: "session.run_state.finalizer",
                  reason: "scope_finalizer",
                  ...(action ? lifecycleCloseActionMeta(action) : {}),
                }),
              {
                concurrency: "unbounded",
                discard: true,
              },
            )
            runners.clear()
          }),
        )
        return { directory: ctx.directory, runners, scope, interruptFallback }
      }),
    )

    const withActiveRun = <A, E>(directory: string, work: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        const activeRun = trackActiveRun(directory)
        return Effect.acquireUseRelease(
          Effect.promise(() => activeRun.promise).pipe(Effect.onInterrupt(() => Effect.sync(activeRun.cancel))),
          () => work,
          (release) => Effect.sync(release),
        )
      })

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: (meta?: InterruptMeta) => Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
        interruptFallback: data.interruptFallback,
        busy: () => {
          throw new Session.BusyError(sessionID)
        },
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) throw new Session.BusyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID, meta?: InterruptMeta) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing || !existing.busy) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancelWith(meta)
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: (meta?: InterruptMeta) => Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      options?: { rejectIfBusy?: boolean },
    ) {
      const directory = yield* Effect.sync(() => Instance.directory)
      return yield* withActiveRun(
        directory,
        Effect.gen(function* () {
          return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work, options)
        }),
      )
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: (meta?: InterruptMeta) => Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Deferred.Deferred<void>,
    ) {
      const directory = yield* Effect.sync(() => Instance.directory)
      return yield* withActiveRun(
        directory,
        Effect.gen(function* () {
          return yield* (yield* runner(sessionID, onInterrupt)).startShell(work, { ready })
        }),
      )
    })

    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(Layer.provide(SessionStatus.defaultLayer))

export * as SessionRunState from "./run-state"
