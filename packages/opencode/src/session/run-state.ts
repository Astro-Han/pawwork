import { InstanceState } from "@/effect/instance-state"
import { Runner, type InterruptMeta } from "@/effect/runner"
import { Cause, Deferred, Effect, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { currentLifecycleCloseAction, lifecycleCloseActionMeta, trackActiveRun } from "./lifecycle-provenance"
import { RunLifecycle } from "./run-lifecycle"

type RunLifecycleObserver = {
  onWaitStarted?: (event: RunLifecycle.Event) => Effect.Effect<void, unknown>
  onWaitEnded?: (event: RunLifecycle.Event) => Effect.Effect<void, unknown>
}

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID, meta?: InterruptMeta) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: (meta?: InterruptMeta) => Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    options?: { rejectIfBusy?: boolean; runLifecycle?: RunLifecycleObserver },
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

    const withActiveRun = <A, E>(
      directory: string,
      sessionID: SessionID,
      work: Effect.Effect<A, E>,
      observer?: RunLifecycleObserver,
    ) =>
      Effect.suspend(() => {
        const activeRun = trackActiveRun(directory)
        let acquiredRelease: (() => void) | undefined
        const releaseAcquired = () => {
          const release = acquiredRelease
          acquiredRelease = undefined
          release?.()
        }
        const cleanupAcquire = Effect.sync(() => {
          activeRun.cancel()
          releaseAcquired()
        })
        const notify = (
          fn: ((event: RunLifecycle.Event) => Effect.Effect<void, unknown>) | undefined,
          event: RunLifecycle.Event,
        ) =>
          fn?.(event).pipe(
            Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.void)),
          ) ?? Effect.void
        const waitForActiveRun = Effect.callback<() => void>((resume) => {
          activeRun.promise.then(
            (release) => {
              acquiredRelease = release
              resume(Effect.succeed(release))
            },
            () => resume(Effect.interrupt),
          )
          return cleanupAcquire
        })
        const acquire = Effect.gen(function* () {
          if (activeRun.wait && observer?.onWaitStarted) {
            yield* notify(observer.onWaitStarted, {
              schema_version: RunLifecycle.SCHEMA_VERSION,
              type: "run_wait_started",
              session_id: sessionID,
              at: activeRun.wait.startedAt,
              reason: activeRun.wait.reason,
              lifecycle: activeRun.wait.lifecycle ? RunLifecycle.lifecycleFromMeta(activeRun.wait.lifecycle) : undefined,
            })
          }
          yield* waitForActiveRun
          return acquiredRelease!
        }).pipe(
          Effect.interruptible,
          Effect.onInterrupt(() => cleanupAcquire),
        )
        const runWork = Effect.gen(function* () {
          if (activeRun.wait && observer?.onWaitEnded) {
            const endedAt = Date.now()
            yield* notify(observer.onWaitEnded, {
              schema_version: RunLifecycle.SCHEMA_VERSION,
              type: "run_wait_ended",
              session_id: sessionID,
              at: endedAt,
              duration_ms: Math.max(0, performance.now() - activeRun.wait.startedMonotonicMs),
              reason: activeRun.wait.reason,
              lifecycle: activeRun.wait.lifecycle ? RunLifecycle.lifecycleFromMeta(activeRun.wait.lifecycle) : undefined,
            })
          }
          return yield* work
        })
        return Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const release = yield* restore(acquire)
            acquiredRelease = undefined
            return yield* restore(runWork).pipe(Effect.ensuring(Effect.sync(release)))
          }),
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
      options?: { rejectIfBusy?: boolean; runLifecycle?: RunLifecycleObserver },
    ) {
      const data = yield* InstanceState.get(state)
      const runnerOptions =
        options?.rejectIfBusy === undefined ? undefined : { rejectIfBusy: options.rejectIfBusy }
      return yield* withActiveRun(
        data.directory,
        sessionID,
        Effect.gen(function* () {
          return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work, runnerOptions)
        }),
        options?.runLifecycle,
      )
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: (meta?: InterruptMeta) => Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Deferred.Deferred<void>,
    ) {
      const data = yield* InstanceState.get(state)
      return yield* withActiveRun(
        data.directory,
        sessionID,
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
