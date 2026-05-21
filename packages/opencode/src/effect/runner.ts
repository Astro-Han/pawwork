import { Cause, Deferred, Effect, Exit, Fiber, Ref, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (
    work: Effect.Effect<A, E>,
    options?: { rejectIfBusy?: boolean },
  ) => Effect.Effect<A, E>
  readonly startShell: (work: Effect.Effect<A, E>, options?: { ready?: Deferred.Deferred<void> }) => Effect.Effect<A, E>
  readonly cancel: Effect.Effect<void>
  readonly cancelWith: (meta?: InterruptMeta) => Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  interruptMeta: Ref.Ref<InterruptMeta | undefined>
  fiber: Fiber.Fiber<A, E>
}

interface ShellHandle<A, E> {
  id: number
  ready: Deferred.Deferred<void>
  cancelled: Deferred.Deferred<void>
  interruptMeta: Ref.Ref<InterruptMeta | undefined>
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  interruptMeta: Ref.Ref<InterruptMeta | undefined>
  work: Effect.Effect<A, E>
}

export interface InterruptMeta {
  source?: string
  reason?: string
  lifecycleActionID?: string
  lifecycleKind?: string
  // Reserved for future paths that originate from a tool or model ctx.abort signal instead of
  // an explicit session.cancel call.
  viaCtxAbort?: boolean
  propagationPoint?: string
  recordedAt?: number
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: ShellHandle<A, E>; readonly run: PendingHandle<A, E> }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: (meta?: InterruptMeta) => Effect.Effect<A, E>
    interruptFallback?: InterruptMeta | (() => InterruptMeta)
    busy?: () => never
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const busy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }
  const withRecordedInterruptMeta = (meta: InterruptMeta | undefined, fallback: InterruptMeta): InterruptMeta => ({
    ...fallback,
    ...meta,
    recordedAt: meta?.recordedAt ?? Date.now(),
  })
  const interruptFallback = opts?.interruptFallback ?? {
    source: "runner.interrupt_without_meta",
    reason: "fiber_interrupt_without_meta",
  }
  const getInterruptFallback = () =>
    typeof interruptFallback === "function" ? interruptFallback() : interruptFallback

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const idleIfCurrent = () =>
    SynchronizedRef.modify(ref, (st) => [st._tag === "Idle" ? idle : Effect.void, st] as const).pipe(Effect.flatten)

  const finishRun = (id: number, done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    SynchronizedRef.modify(
      ref,
      (st) =>
        [
          Effect.gen(function* () {
            if (st._tag === "Running" && st.run.id === id) yield* idle
            yield* complete(done, exit)
          }),
          st._tag === "Running" && st.run.id === id ? ({ _tag: "Idle" } as const) : st,
        ] as const,
    ).pipe(Effect.flatten)

  const startRun = (
    work: Effect.Effect<A, E>,
    done: Deferred.Deferred<A, E | Cancelled>,
    interruptMeta: Ref.Ref<InterruptMeta | undefined>,
  ) =>
    Effect.gen(function* () {
      const id = next()
      const fiber = yield* work.pipe(
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope),
      )
      return { id, done, interruptMeta, fiber } satisfies RunHandle<A, E>
    })

  const resolveInterrupt = (interruptMeta: Ref.Ref<InterruptMeta | undefined>): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      const meta = withRecordedInterruptMeta(yield* Ref.get(interruptMeta), getInterruptFallback())
      if (onInterrupt) return yield* onInterrupt(meta)
      return yield* Effect.die(new Cancelled())
    })

  const awaitRun = (run: Pick<RunHandle<A, E>, "done" | "interruptMeta"> | PendingHandle<A, E>) =>
    Deferred.await(run.done).pipe(
      Effect.catch((e): Effect.Effect<A, E> =>
        e instanceof Cancelled ? resolveInterrupt(run.interruptMeta) : Effect.fail(e as E),
      ),
    )

  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Shell" && st.shell.id === id) return [idle, { _tag: "Idle" }] as const
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          const run = yield* startRun(st.run.work, st.run.done, st.run.interruptMeta)
          return [Effect.void, { _tag: "Running", run }] as const
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      yield* awaitShellReady(shell)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const awaitShellReady = (shell: ShellHandle<A, E>) =>
    Deferred.await(shell.ready).pipe(Effect.raceFirst(Fiber.await(shell.fiber).pipe(Effect.asVoid)), Effect.ignore)

  const ensureRunning = (work: Effect.Effect<A, E>, options?: { rejectIfBusy?: boolean }) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        // rejectIfBusy lives in the atomic ref-modify so the check can't race
        // with an Idle→Running transition started by another caller. Throwing
        // synchronously here (via opts.busy()) lets `loop({ prelude })` refuse
        // to silently no-op when the runner is already executing other work —
        // otherwise the prelude effect (e.g. writing a compaction marker)
        // would be dropped and the route would resolve `true` for a session
        // that never ran the requested action.
        if (options?.rejectIfBusy && st._tag !== "Idle") {
          if (opts?.busy) opts.busy()
          throw new Error("Runner is busy")
        }
        switch (st._tag) {
          case "Running":
          case "ShellThenRun":
            return [awaitRun(st.run), st] as const
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              interruptMeta: yield* Ref.make<InterruptMeta | undefined>(undefined),
              work,
            } satisfies PendingHandle<A, E>
            return [awaitRun(run), { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            const interruptMeta = yield* Ref.make<InterruptMeta | undefined>(undefined)
            const run = yield* startRun(work, done, interruptMeta)
            return [awaitRun(run), { _tag: "Running", run }] as const
          }
        }
      }),
    ).pipe(Effect.flatten)

  const startShell = (work: Effect.Effect<A, E>, options?: { ready?: Deferred.Deferred<void> }) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          return [
            Effect.sync(() => {
              if (opts?.busy) opts.busy()
              throw new Error("Runner is busy")
            }),
            st,
          ] as const
        }
        yield* busy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const ready =
          options?.ready ??
          (yield* Deferred.make<void>().pipe(
            Effect.tap((ready) => Deferred.succeed(ready, undefined)),
          ))
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id)), Effect.forkChild)
        const interruptMeta = yield* Ref.make<InterruptMeta | undefined>(undefined)
        const shell = { id, ready, cancelled, interruptMeta, fiber } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              ((yield* Deferred.isDone(cancelled)) &&
                Cause.hasInterrupts(exit.cause) &&
                !Cause.hasFails(exit.cause) &&
                !Cause.hasDies(exit.cause))
            ) {
              return yield* resolveInterrupt(interruptMeta)
            }
            return yield* Effect.failCause(exit.cause)
          }),
          { _tag: "Shell", shell },
        ] as const
      }),
    ).pipe(Effect.flatten)

  const cancelWith = (meta?: InterruptMeta) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        const snapshot = withRecordedInterruptMeta(meta, {
          source: "runner.cancel_without_meta",
          reason: "cancel_without_meta",
        })
        switch (st._tag) {
          case "Idle":
            return [Effect.void, st] as const
          case "Running":
            yield* Ref.set(st.run.interruptMeta, snapshot)
            return [
              Effect.gen(function* () {
                yield* Fiber.interrupt(st.run.fiber)
                yield* Deferred.await(st.run.done).pipe(Effect.exit, Effect.asVoid)
                yield* idleIfCurrent()
              }),
              { _tag: "Idle" } as const,
            ] as const
          case "Shell":
            yield* Ref.set(st.shell.interruptMeta, snapshot)
            return [
              Effect.gen(function* () {
                yield* stopShell(st.shell)
                yield* idleIfCurrent()
              }),
              { _tag: "Idle" } as const,
            ] as const
          case "ShellThenRun":
            yield* Ref.set(st.shell.interruptMeta, snapshot)
            yield* Ref.set(st.run.interruptMeta, snapshot)
            return [
              Effect.gen(function* () {
                yield* stopShell(st.shell)
                yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
                yield* idleIfCurrent()
              }),
              { _tag: "Idle" } as const,
            ] as const
        }
      }),
    ).pipe(Effect.flatten)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    startShell,
    cancel: cancelWith(),
    cancelWith,
  }
}

export const Runner = {
  make,
  Cancelled,
}
