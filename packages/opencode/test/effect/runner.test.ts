import { describe, expect, test } from "bun:test"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Ref, Scope } from "effect"
import { Runner } from "../../src/effect"
import type { Runner as RunnerInstance, State } from "../../src/effect/runner"
import { it } from "../lib/effect"

interface DeferredRuntimeWaiters {
  readonly resumes?: ReadonlyArray<unknown>
}

function waitUntil(message: () => string, ready: () => boolean) {
  return Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    while (!ready()) {
      const now = yield* Clock.currentTimeMillis
      if (now - started > 1_000) {
        return yield* Effect.die(new Error(message()))
      }
      yield* Effect.sleep("1 millis")
    }
  })
}

function waitForRunnerState<A, E>(runner: RunnerInstance<A, E>, tag: State<A, E>["_tag"]) {
  return waitUntil(
    () => `Runner did not enter ${tag}; current state is ${runner.state._tag}`,
    () => runner.state._tag === tag,
  )
}

// Effect Deferred does not expose waiter counts publicly. Keep this test-only
// runtime-shape check private to the shared-run tests that need to prove a
// second caller is waiting on the existing run before cancel/release.
function deferredWaiterCount<A, E>(deferred: Deferred.Deferred<A, E>) {
  return (deferred as DeferredRuntimeWaiters).resumes?.length ?? 0
}

function waitForSharedRunWaiters<A, E>(deferred: Deferred.Deferred<A, E>, count: number, label: string) {
  return waitUntil(
    () => `${label} did not attach ${count} waiter(s); current waiters=${deferredWaiterCount(deferred)}`,
    () => deferredWaiterCount(deferred) >= count,
  )
}

function currentRunDone<A, E>(runner: RunnerInstance<A, E>) {
  return Effect.gen(function* () {
    const state = runner.state
    if (state._tag === "Running" || state._tag === "ShellThenRun") return state.run.done
    return yield* Effect.die(new Error(`Runner has no current run; current state is ${state._tag}`))
  })
}

function makeBlockedWork<A>(value: A, label = "running work") {
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    return {
      waitUntilStarted: Deferred.await(started).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.die(new Error(`${label} did not start`)),
        }),
      ),
      work: Effect.uninterruptibleMask((restore) =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(restore(Deferred.await(release))), Effect.as(value)),
      ),
    }
  })
}

describe("Runner", () => {
  // --- ensureRunning semantics ---

  it.live(
    "ensureRunning starts work and returns result",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const result = yield* runner.ensureRunning(Effect.succeed("hello"))
      expect(result).toBe("hello")
      expect(runner.state._tag).toBe("Idle")
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "ensureRunning propagates work failures",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string, string>(s)
      const exit = yield* runner.ensureRunning(Effect.fail("boom")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "concurrent callers share the same run",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const calls = yield* Ref.make(0)
      const work = Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        yield* Effect.sleep("10 millis")
        return "shared"
      })

      const [a, b] = yield* Effect.all([runner.ensureRunning(work), runner.ensureRunning(work)], {
        concurrency: "unbounded",
      })

      expect(a).toBe("shared")
      expect(b).toBe("shared")
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.live(
    "concurrent callers all receive same error",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string, string>(s)
      const work = Effect.gen(function* () {
        yield* Effect.sleep("10 millis")
        return yield* Effect.fail("boom")
      })

      const [a, b] = yield* Effect.all(
        [runner.ensureRunning(work).pipe(Effect.exit), runner.ensureRunning(work).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      )

      expect(Exit.isFailure(a)).toBe(true)
      expect(Exit.isFailure(b)).toBe(true)
    }),
  )

  it.live(
    "ensureRunning can be called again after previous run completes",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      expect(yield* runner.ensureRunning(Effect.succeed("first"))).toBe("first")
      expect(yield* runner.ensureRunning(Effect.succeed("second"))).toBe("second")
    }),
  )

  it.live(
    "second ensureRunning ignores new work if already running",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const ran = yield* Ref.make<string[]>([])

      const first = Effect.gen(function* () {
        yield* Ref.update(ran, (a) => [...a, "first"])
        yield* Effect.sleep("50 millis")
        return "first-result"
      })
      const second = Effect.gen(function* () {
        yield* Ref.update(ran, (a) => [...a, "second"])
        return "second-result"
      })

      const [a, b] = yield* Effect.all([runner.ensureRunning(first), runner.ensureRunning(second)], {
        concurrency: "unbounded",
      })

      expect(a).toBe("first-result")
      expect(b).toBe("first-result")
      expect(yield* Ref.get(ran)).toEqual(["first"])
    }),
  )

  // --- cancel semantics ---

  it.live(
    "cancel interrupts running work",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const blocked = yield* makeBlockedWork("never")
      const fiber = yield* runner.ensureRunning(blocked.work).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Running")
      yield* blocked.waitUntilStarted
      expect(runner.busy).toBe(true)
      expect(runner.state._tag).toBe("Running")

      yield* runner.cancel
      expect(runner.busy).toBe(false)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.live(
    "cancel on idle is a no-op",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      yield* runner.cancel
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "cancel with onInterrupt resolves callers gracefully",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: () => Effect.succeed("fallback") })
      const blocked = yield* makeBlockedWork("never")
      const fiber = yield* runner.ensureRunning(blocked.work).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Running")
      yield* blocked.waitUntilStarted

      yield* runner.cancel

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe("fallback")
    }),
  )

  it.live(
    "cancel without metadata annotates the interrupt source",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, {
        onInterrupt: (meta) => Effect.succeed(`${meta?.source}:${meta?.reason}:${typeof meta?.recordedAt}`),
      })
      const blocked = yield* makeBlockedWork("never")
      const fiber = yield* runner.ensureRunning(blocked.work).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Running")
      yield* blocked.waitUntilStarted

      yield* runner.cancel

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe("runner.cancel_without_meta:cancel_without_meta:number")
    }),
  )

  it.live(
    "scope interruption without metadata annotates the interrupt source",
    Effect.gen(function* () {
      const s = yield* Scope.make()
      const runner = Runner.make<string>(s, {
        onInterrupt: (meta) => Effect.succeed(`${meta?.source}:${meta?.reason}:${typeof meta?.recordedAt}`),
      })
      const blocked = yield* makeBlockedWork("never")
      const fiber = yield* runner.ensureRunning(blocked.work).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Running")
      yield* blocked.waitUntilStarted

      yield* Scope.close(s, Exit.void)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toBe("runner.interrupt_without_meta:fiber_interrupt_without_meta:number")
      }
    }),
  )

  it.live(
    "cancel with queued callers resolves all",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: () => Effect.succeed("fallback") })
      const blocked = yield* makeBlockedWork("x")

      const a = yield* runner.ensureRunning(blocked.work).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Running")
      yield* blocked.waitUntilStarted
      const done = yield* currentRunDone(runner)
      const b = yield* runner.ensureRunning(Effect.succeed("y")).pipe(Effect.forkChild)
      yield* waitForSharedRunWaiters(done, 2, "running run")

      yield* runner.cancel

      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA)) expect(exitA.value).toBe("fallback")
      if (Exit.isSuccess(exitB)) expect(exitB.value).toBe("fallback")
    }),
  )

  it.live(
    "cancel binds interrupt metadata to the interrupted run",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const release = yield* Deferred.make<void>()
      const runner = Runner.make<string>(s, {
        onInterrupt: (meta) => Effect.succeed(meta?.reason ?? "missing"),
      })
      const blocked = yield* makeBlockedWork("never")
      const work = blocked.work.pipe(
        Effect.onInterrupt(() => Deferred.await(release)),
      )

      const fiber = yield* runner.ensureRunning(work).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Running")
      yield* blocked.waitUntilStarted

      yield* runner.cancelWith({ source: "first", reason: "first" }).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Idle")
      yield* runner.cancelWith({ source: "second", reason: "second" })
      yield* Deferred.succeed(release, undefined)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe("first")
    }),
  )

  it.live(
    "work can be started after cancel",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const blocked = yield* makeBlockedWork("x")
      const fiber = yield* runner.ensureRunning(blocked.work).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Running")
      yield* blocked.waitUntilStarted
      yield* runner.cancel
      yield* Fiber.await(fiber)

      const result = yield* runner.ensureRunning(Effect.succeed("after-cancel"))
      expect(result).toBe("after-cancel")
    }),
  )

  test("cancel does not deadlock when replacement work starts before interrupted run exits", async () => {
    function defer() {
      let resolve!: () => void
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      return { promise, resolve }
    }

    function fail(ms: number, msg: string) {
      return new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(msg)), ms)
      })
    }

    const s = await Effect.runPromise(Scope.make())
    const hit = defer()
    const hold = defer()
    const done = defer()
    try {
      const runner = Runner.make<string>(s)
      const first = Effect.never.pipe(
        Effect.onInterrupt(() => Effect.sync(() => hit.resolve())),
        Effect.ensuring(Effect.promise(() => hold.promise)),
        Effect.as("first"),
      )

      const a = Effect.runPromiseExit(runner.ensureRunning(first))
      await Bun.sleep(10)

      const stop = Effect.runPromise(runner.cancel)
      await Promise.race([hit.promise, fail(250, "cancel did not interrupt running work")])

      const b = Effect.runPromise(runner.ensureRunning(Effect.promise(() => done.promise).pipe(Effect.as("second"))))
      expect(runner.busy).toBe(true)

      hold.resolve()
      await Promise.race([stop, fail(250, "cancel deadlocked while replacement run was active")])

      expect(runner.busy).toBe(true)
      done.resolve()
      expect(await b).toBe("second")
      expect(runner.busy).toBe(false)

      const exit = await a
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      hold.resolve()
      done.resolve()
      await Promise.race([Effect.runPromise(Scope.close(s, Exit.void)), fail(1000, "runner scope did not close")])
    }
  })

  // --- shell semantics ---

  it.live(
    "shell runs exclusively",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const result = yield* runner.startShell(Effect.succeed("shell-done"))
      expect(result).toBe("shell-done")
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "shell rejects when run is active",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const blocked = yield* makeBlockedWork("x")
      const fiber = yield* runner.ensureRunning(blocked.work).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Running")
      yield* blocked.waitUntilStarted

      const exit = yield* runner.startShell(Effect.succeed("nope")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)

      yield* runner.cancel
      yield* Fiber.await(fiber)
    }),
  )

  it.live(
    "shell rejects when another shell is running",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("first"))).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Shell")

      const exit = yield* runner.startShell(Effect.succeed("second")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)
    }),
  )

  it.live(
    "shell rejects via busy callback and cancel still stops the first shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, {
        busy: () => {
          throw new Error("busy")
        },
      })

      const sh = yield* runner.startShell(Effect.never.pipe(Effect.as("aborted"))).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Shell")

      const exit = yield* runner.startShell(Effect.succeed("second")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)

      yield* runner.cancel
      const done = yield* Fiber.await(sh)
      expect(Exit.isFailure(done)).toBe(true)
    }),
  )

  it.live(
    "cancel interrupts shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("ignored"))).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Shell")

      const stop = yield* runner.cancel.pipe(Effect.forkChild)
      const stopExit = yield* Fiber.await(stop).pipe(Effect.timeout("250 millis"))
      expect(Exit.isSuccess(stopExit)).toBe(true)
      expect(runner.busy).toBe(false)

      const shellExit = yield* Fiber.await(sh)
      expect(Exit.isFailure(shellExit)).toBe(true)

      yield* Deferred.succeed(gate, undefined).pipe(Effect.ignore)
    }),
  )

  it.live(
    "cancel does not mask shell defects",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s, { onInterrupt: () => Effect.succeed("interrupted") })

      const sh = yield* runner
        .startShell(Effect.never.pipe(Effect.ensuring(Effect.die("boom")), Effect.as("ignored")))
        .pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Shell")

      yield* runner.cancel
      expect(Exit.isFailure(yield* Fiber.await(sh))).toBe(true)
    }),
  )

  it.live(
    "cancel does not mask shell typed failures",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string, string>(s, { onInterrupt: () => Effect.succeed("interrupted") })

      const sh = yield* runner
        .startShell(Effect.never.pipe(Effect.onInterrupt(() => Effect.fail("boom")), Effect.as("ignored")))
        .pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Shell")

      yield* runner.cancel
      const exit = yield* Fiber.await(sh)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasFails(exit.cause)).toBe(true)
      }
    }),
  )

  // --- shell→run handoff ---

  it.live(
    "ensureRunning queues behind shell then runs after",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("shell-result"))).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Shell")
      expect(runner.state._tag).toBe("Shell")

      const run = yield* runner.ensureRunning(Effect.succeed("run-result")).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "ShellThenRun")
      expect(runner.state._tag).toBe("ShellThenRun")

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) expect(exit.value).toBe("run-result")
      expect(runner.state._tag).toBe("Idle")
    }),
  )

  it.live(
    "multiple ensureRunning callers share the queued run behind shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const calls = yield* Ref.make(0)
      const gate = yield* Deferred.make<void>()

      const sh = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("shell"))).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Shell")

      const work = Effect.gen(function* () {
        yield* Ref.update(calls, (n) => n + 1)
        return "run"
      })
      const a = yield* runner.ensureRunning(work).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "ShellThenRun")
      const done = yield* currentRunDone(runner)
      const b = yield* runner.ensureRunning(work).pipe(Effect.forkChild)
      yield* waitForSharedRunWaiters(done, 2, "queued shell run")

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(sh)

      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.live(
    "cancel during shell_then_run cancels both",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)

      const sh = yield* runner.startShell(Effect.never.pipe(Effect.as("aborted"))).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Shell")

      const run = yield* runner.ensureRunning(Effect.succeed("y")).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "ShellThenRun")
      expect(runner.state._tag).toBe("ShellThenRun")

      yield* runner.cancel
      expect(runner.busy).toBe(false)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(run)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  // --- lifecycle callbacks ---

  it.live(
    "onIdle fires when returning to idle from running",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onIdle: Ref.update(count, (n) => n + 1),
      })
      yield* runner.ensureRunning(Effect.succeed("ok"))
      expect(yield* Ref.get(count)).toBe(1)
    }),
  )

  it.live(
    "onIdle fires on cancel",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onIdle: Ref.update(count, (n) => n + 1),
      })
      const blocked = yield* makeBlockedWork("x")
      const fiber = yield* runner.ensureRunning(blocked.work).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Running")
      yield* blocked.waitUntilStarted
      yield* runner.cancel
      yield* Fiber.await(fiber)
      expect(yield* Ref.get(count)).toBeGreaterThanOrEqual(1)
    }),
  )

  it.live(
    "onBusy fires when shell starts",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const count = yield* Ref.make(0)
      const runner = Runner.make<string>(s, {
        onBusy: Ref.update(count, (n) => n + 1),
      })
      yield* runner.startShell(Effect.succeed("done"))
      expect(yield* Ref.get(count)).toBe(1)
    }),
  )

  // --- busy flag ---

  it.live(
    "busy is true during run",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const fiber = yield* runner.ensureRunning(Deferred.await(gate).pipe(Effect.as("ok"))).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Running")
      expect(runner.busy).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(fiber)
      expect(runner.busy).toBe(false)
    }),
  )

  it.live(
    "busy is true during shell",
    Effect.gen(function* () {
      const s = yield* Scope.Scope
      const runner = Runner.make<string>(s)
      const gate = yield* Deferred.make<void>()

      const fiber = yield* runner.startShell(Deferred.await(gate).pipe(Effect.as("ok"))).pipe(Effect.forkChild)
      yield* waitForRunnerState(runner, "Shell")
      expect(runner.busy).toBe(true)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(fiber)
      expect(runner.busy).toBe(false)
    }),
  )
})
