import { Context, Effect, Fiber, Layer } from "effect"
import { Automation } from "."
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { NotFoundError } from "@/storage/db"
import { sessionPromptExecutor } from "./runner"

export namespace AutomationScheduler {
  const MAX_TIMER_DELAY_MS = 2_147_483_647

  export interface Clock {
    now(): number
    sleep(delayMs: number, signal: AbortSignal): Promise<void>
  }

  export interface Task {
    interrupt(): void
  }

  export interface TaskRuntime {
    fork(run: (signal: AbortSignal) => Effect.Effect<void>): Task
  }

  export interface Interface {
    stop(): void
    reschedule(definition: Automation.Definition): void
    cancel(automationID: string): void
    computeNextFireAt(definition: Automation.Definition, from?: number): number | null
  }

  export interface Options {
    clock?: Clock
    executor?: Automation.RunExecutor
    runtime?: TaskRuntime
  }

  export const liveClock: Clock = {
    now: () => Date.now(),
    sleep: (delayMs, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        const id = setTimeout(resolve, delayMs)
        id.unref?.()
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(id)
            resolve()
          },
          { once: true },
        )
      }),
  }

  export const liveRuntime: TaskRuntime = {
    fork(run) {
      const controller = new AbortController()
      const fiber = Effect.runFork(run(controller.signal))
      return {
        interrupt() {
          controller.abort()
          Effect.runFork(Fiber.interrupt(fiber))
        },
      }
    },
  }

  export class Service extends Context.Service<Service, Interface>()("@pawwork/AutomationScheduler") {}

  export const layer = (options?: Options) =>
    Layer.effect(
      Service,
      Effect.gen(function* () {
        const scheduler = make(options)
        yield* Effect.addFinalizer(() => Effect.sync(() => scheduler.stop()))
        return Service.of(scheduler)
      }),
    )
  export const defaultLayer = layer()

  export function computeNextFireAt(definition: Automation.Definition, from: number): number | null {
    if (definition.paused) return null
    if (definition.kind === "oneshot") {
      if (Automation.hasRunTriggeredAtOrAfter(definition.id, definition.fireAt)) return null
      return definition.fireAt
    }
    if (definition.rhythm.kind !== "interval") return null
    return from + definition.rhythm.everyMs
  }

  export function make(options: Options = {}): Interface {
    const clock = options.clock ?? liveClock
    const executor = options.executor ?? sessionPromptExecutor
    const runtime = options.runtime ?? liveRuntime
    const tasks = new Map<string, Task>()
    let running = true

    const cancel = (automationID: string) => {
      const task = tasks.get(automationID)
      if (!task) return
      tasks.delete(automationID)
      task.interrupt()
    }

    const scheduleNextInterval = (automationID: string) => {
      try {
        const latest = Automation.get(automationID)
        if (latest.kind === "recurring" && latest.rhythm.kind === "interval" && !latest.paused) {
          schedule(latest, clock.now() + latest.rhythm.everyMs)
        }
      } catch (error) {
        if (!NotFoundError.isInstance(error)) throw error
      }
    }

    const fire = (automationID: string, triggeredAt: number) => {
      tasks.delete(automationID)
      if (Automation.hasActiveRun(automationID)) {
        const stopped = Automation.recordStoppedRun(automationID, "previous_run_awaiting_input", { now: triggeredAt })
        void Automation.publishRunUpdated(stopped)
        scheduleNextInterval(automationID)
        return
      }
      try {
        Automation.runNowExecuting(automationID, {
          executor,
          attendance: "unattended",
          now: triggeredAt,
        })
      } catch (error) {
        if (!NotFoundError.isInstance(error)) throw error
      }
    }

    const waitUntil = (automationID: string, fireAt: number, signal: AbortSignal): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (clock.now() < fireAt) {
          const delayMs = Math.max(0, fireAt - clock.now())
          yield* Effect.promise(() => clock.sleep(Math.min(delayMs, MAX_TIMER_DELAY_MS), signal))
        }
        if (!running || !tasks.has(automationID)) return
        fire(automationID, fireAt)
      })

    const schedule = (definition: Automation.Definition, fireAt: number) => {
      cancel(definition.id)
      if (!running || definition.paused) return
      tasks.set(definition.id, runtime.fork((signal) => waitUntil(definition.id, fireAt, signal)))
    }

    const reschedule = (definition: Automation.Definition) => {
      const next = computeNextFireAt(definition, clock.now())
      if (next === null) {
        cancel(definition.id)
        return
      }
      schedule(definition, next)
    }

    const unsubscribeRunUpdates = Bus.subscribe(Automation.Event.RunUpdated, (event) => {
      if (!running) return
      const run = event.properties
      if (run.state === "scheduled" || run.state === "running" || run.state === "awaiting_input") return
      scheduleNextInterval(run.automationID)
    })

    for (const definition of Automation.list()) reschedule(definition)

    return {
      stop() {
        running = false
        unsubscribeRunUpdates()
        for (const automationID of [...tasks.keys()]) cancel(automationID)
      },
      reschedule,
      cancel,
      computeNextFireAt(definition, from = clock.now()) {
        return computeNextFireAt(definition, from)
      },
    }
  }

  const owner = Instance.state<{ scheduler: Interface }>(
    () => ({ scheduler: make() }),
    async (state) => state.scheduler.stop(),
  )

  export function current(): Interface {
    return owner().scheduler
  }

  export function install(scheduler: Interface): Interface {
    const state = owner()
    const previous = state.scheduler
    previous.stop()
    state.scheduler = scheduler
    return previous
  }
}
