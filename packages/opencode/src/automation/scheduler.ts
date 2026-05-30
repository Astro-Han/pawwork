import { Context, Effect, Fiber, Layer } from "effect"
import { Automation } from "."
import { Bus } from "@/bus"
import { Instance, type InstanceContext } from "@/project/instance"
import { NotFoundError } from "@/storage/db"
import { sessionPromptExecutor } from "./runner"

export namespace AutomationScheduler {
  const MAX_TIMER_DELAY_MS = 2_147_483_647
  const MISSED_SCHEDULE_GRACE_MS = 60_000

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
    stopOwnedRuns(): void
    reschedule(definition: Automation.Definition): void
    cancel(automationID: string): void
    computeNextFireAt(definition: Automation.Definition, from?: number): number | null
  }

  export interface Options {
    clock?: Clock
    executor?: Automation.RunExecutor
    runtime?: TaskRuntime
  }

  type ScheduledTask = {
    task: Task
    fireAt: number
    token: symbol
    definition: Automation.Definition
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
    if (!canScheduleRecurring(definition)) return null
    if (definition.rhythm.kind !== "interval") return null
    return from + definition.rhythm.everyMs
  }

  function canScheduleRecurring(definition: Extract<Automation.Definition, { kind: "recurring" }>) {
    if (definition.stop.kind === "never") return true
    if (definition.stop.kind === "count") return Automation.completedRunCount(definition.id) < definition.stop.count
    return false
  }

  function isSameSchedule(left: Automation.Definition, right: Automation.Definition) {
    if (left.kind !== right.kind || left.paused !== right.paused) return false
    if (left.kind === "oneshot" && right.kind === "oneshot") return left.fireAt === right.fireAt
    if (left.kind === "recurring" && right.kind === "recurring") {
      return JSON.stringify(left.rhythm) === JSON.stringify(right.rhythm) && JSON.stringify(left.stop) === JSON.stringify(right.stop)
    }
    return false
  }

  export function make(options: Options = {}): Interface {
    const clock = options.clock ?? liveClock
    const executor = options.executor ?? sessionPromptExecutor
    const runtime = options.runtime ?? liveRuntime
    const tasks = new Map<string, ScheduledTask>()
    const ownedRuns = new Map<string, string>()
    const schedulerStoppedRuns = new Set<string>()
    let running = true

    const cancel = (automationID: string) => {
      const entry = tasks.get(automationID)
      if (!entry) return
      tasks.delete(automationID)
      entry.task.interrupt()
    }

    const scheduleNextInterval = (automationID: string) => {
      try {
        const latest = Automation.get(automationID)
        if (latest.kind === "recurring" && latest.rhythm.kind === "interval" && !latest.paused && canScheduleRecurring(latest)) {
          schedule(latest, clock.now() + latest.rhythm.everyMs)
        } else {
          cancel(automationID)
        }
      } catch (error) {
        cancel(automationID)
        if (!NotFoundError.isInstance(error)) throw error
      }
    }

    const fire = (automationID: string, triggeredAt: number) => {
      tasks.delete(automationID)
      const firedAt = clock.now()
      try {
        const latest = Automation.get(automationID)
        if (latest.paused) return
        if (latest.kind === "oneshot" && latest.fireAt !== triggeredAt) return
        if (latest.kind === "recurring" && (latest.rhythm.kind !== "interval" || !canScheduleRecurring(latest))) return
        if (firedAt - triggeredAt > MISSED_SCHEDULE_GRACE_MS) {
          const stopped = Automation.recordStoppedRun(automationID, "missed_schedule", { now: firedAt, triggeredAt })
          schedulerStoppedRuns.add(stopped.id)
          void Automation.publishRunUpdated(stopped)
          if (latest.kind === "recurring") scheduleNextInterval(automationID)
          return
        }
      } catch (error) {
        if (!NotFoundError.isInstance(error)) throw error
        return
      }
      if (Automation.hasActiveRun(automationID)) {
        const stopped = Automation.recordStoppedRun(automationID, "previous_run_awaiting_input", { now: triggeredAt })
        schedulerStoppedRuns.add(stopped.id)
        void Automation.publishRunUpdated(stopped)
        scheduleNextInterval(automationID)
        return
      }
      try {
        const run = Automation.runNowExecuting(automationID, {
          executor,
          attendance: "unattended",
          now: triggeredAt,
        })
        ownedRuns.set(run.id, automationID)
      } catch (error) {
        if (!NotFoundError.isInstance(error)) throw error
      }
    }

    const isCurrentTask = (automationID: string, fireAt: number, token: symbol, signal: AbortSignal) => {
      const current = tasks.get(automationID)
      return !signal.aborted && running && current?.token === token && current.fireAt === fireAt
    }

    const waitUntil = (automationID: string, fireAt: number, token: symbol, signal: AbortSignal): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (clock.now() < fireAt) {
          const delayMs = Math.max(0, fireAt - clock.now())
          yield* Effect.promise(() => clock.sleep(Math.min(delayMs, MAX_TIMER_DELAY_MS), signal))
          if (!isCurrentTask(automationID, fireAt, token, signal)) return
        }
        if (!isCurrentTask(automationID, fireAt, token, signal)) return
        fire(automationID, fireAt)
      })

    const schedule = (definition: Automation.Definition, fireAt: number) => {
      cancel(definition.id)
      if (!running || definition.paused) return
      const token = Symbol(definition.id)
      tasks.set(definition.id, {
        task: runtime.fork((signal) => waitUntil(definition.id, fireAt, token, signal)),
        fireAt,
        token,
        definition,
      })
    }

    const preservePendingSchedule = (definition: Automation.Definition) => {
      const current = tasks.get(definition.id)
      if (!current || current.fireAt <= clock.now() || !isSameSchedule(current.definition, definition)) return false
      current.definition = definition
      return true
    }

    const hasSchedulerOwnedActiveRun = (automationID: string) => {
      for (const ownedAutomationID of ownedRuns.values()) {
        if (ownedAutomationID === automationID) return true
      }
      return false
    }

    const reschedule = (definition: Automation.Definition) => {
      const next = computeNextFireAt(definition, clock.now())
      if (next === null) {
        cancel(definition.id)
        return
      }
      if (preservePendingSchedule(definition)) return
      if (!tasks.has(definition.id) && definition.kind === "recurring" && hasSchedulerOwnedActiveRun(definition.id)) return
      schedule(definition, next)
    }

    const unsubscribeRunUpdates = Bus.subscribe(Automation.Event.RunUpdated, (event) => {
      if (!running) return
      const run = event.properties
      if (run.state === "scheduled" || run.state === "running" || run.state === "awaiting_input") return
      const wasOwned = ownedRuns.delete(run.id)
      const wasSchedulerStopped = schedulerStoppedRuns.delete(run.id)
      if (run.state === "stopped" && !wasOwned && !wasSchedulerStopped) return
      scheduleNextInterval(run.automationID)
    })
    const unsubscribeDefinitionUpdates = Bus.subscribe(Automation.Event.DefinitionUpdated, (event) => {
      if (!running) return
      reschedule(event.properties)
    })
    const unsubscribeDefinitionDeletes = Bus.subscribe(Automation.Event.DefinitionDeleted, (event) => {
      if (!running) return
      cancel(event.properties.id)
    })

    for (const definition of Automation.list()) reschedule(definition)

    const stopOwnedRuns = () => {
      for (const runID of [...ownedRuns.keys()]) {
        const stopped = Automation.stopRunByID(runID, "cancelled", { now: clock.now() })
        ownedRuns.delete(runID)
        if (stopped) void Automation.publishRunUpdated(stopped)
      }
    }

    return {
      stop() {
        running = false
        unsubscribeRunUpdates()
        unsubscribeDefinitionUpdates()
        unsubscribeDefinitionDeletes()
        stopOwnedRuns()
        for (const automationID of [...tasks.keys()]) cancel(automationID)
      },
      stopOwnedRuns,
      reschedule,
      cancel,
      computeNextFireAt(definition, from = clock.now()) {
        return computeNextFireAt(definition, from)
      },
    }
  }

  type OwnerState = {
    context: InstanceContext
    scheduler: Interface
  }

  const owners = new Map<string, OwnerState>()
  const owner = Instance.state<OwnerState>(
    () => {
      const context = Instance.current
      const state = { context, scheduler: make() }
      owners.set(context.directory, state)
      return state
    },
    async (state) => {
      owners.delete(state.context.directory)
      Instance.restore(state.context, () => state.scheduler.stop())
    },
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

  export function stopCurrentOwnedRuns(): void {
    const state = owner()
    Instance.restore(state.context, () => state.scheduler.stopOwnedRuns())
  }

  export function stopDirectoryOwnedRuns(directory: string): void {
    const state = owners.get(directory)
    if (!state) return
    Instance.restore(state.context, () => state.scheduler.stopOwnedRuns())
  }

  export function stopAllOwnedRuns(): void {
    for (const state of owners.values()) {
      Instance.restore(state.context, () => state.scheduler.stopOwnedRuns())
    }
  }
}
