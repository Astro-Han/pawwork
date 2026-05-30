import { Context, Effect, Fiber, Layer } from "effect"
import { DateTime } from "luxon"
import { Automation } from "."
import { Bus } from "@/bus"
import { Instance, type InstanceContext } from "@/project/instance"
import { NotFoundError } from "@/storage/db"
import { Flock } from "@/util/flock"
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
    settleOwner(): Promise<void>
    reschedule(definition: Automation.Definition): void
    cancel(automationID: string): void
    computeNextFireAt(definition: Automation.Definition, from?: number): number | null
  }

  export interface Options {
    clock?: Clock
    executor?: Automation.RunExecutor
    runtime?: TaskRuntime
    ownerKey?: string
    ownerRetryMs?: number
    ownerRescanMs?: number
  }

  type ScheduledTask = {
    task: Task
    fireAt: number
    token: symbol
    definition: Automation.Definition
  }

  type CronSchedule = {
    minutes: Set<number>
    hours: Set<number>
    days: Set<number>
    months: Set<number>
    weekdays: Set<number>
    dayRestricted: boolean
    weekdayRestricted: boolean
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
    if (definition.rhythm.kind === "cron") return computeNextCronFireAt(definition, from)
    return from + definition.rhythm.everyMs
  }

  function cronValues(field: string, min: number, max: number, options?: { sundayAlias?: boolean }) {
    const values = new Set<number>()
    for (const item of field.split(",")) {
      const [base, stepRaw] = item.split("/")
      const step = stepRaw === undefined ? 1 : Number(stepRaw)
      const range = base === "*" ? [min, max] : base.split("-").map(Number)
      const start = range[0]
      const end = base === "*" || (range.length === 1 && stepRaw !== undefined) ? max : range.length === 1 ? range[0] : range[1]
      for (let value = start; value <= end; value += step) {
        values.add(options?.sundayAlias && value === 7 ? 0 : value)
      }
    }
    return values
  }

  function parseCronSchedule(expression: string): CronSchedule {
    const [minuteField, hourField, dayField, monthField, weekdayField] = expression.trim().split(/\s+/)
    return {
      minutes: cronValues(minuteField, 0, 59),
      hours: cronValues(hourField, 0, 23),
      days: cronValues(dayField, 1, 31),
      months: cronValues(monthField, 1, 12),
      weekdays: cronValues(weekdayField, 0, 7, { sundayAlias: true }),
      dayRestricted: dayField !== "*",
      weekdayRestricted: weekdayField !== "*",
    }
  }

  function cronMatches(schedule: CronSchedule, time: DateTime) {
    const weekday = time.weekday === 7 ? 0 : time.weekday
    const dayMatches = schedule.days.has(time.day)
    const weekdayMatches = schedule.weekdays.has(weekday)
    const calendarMatches =
      schedule.dayRestricted && schedule.weekdayRestricted ? dayMatches || weekdayMatches : dayMatches && weekdayMatches
    return (
      schedule.minutes.has(time.minute) &&
      schedule.hours.has(time.hour) &&
      schedule.months.has(time.month) &&
      calendarMatches
    )
  }

  function computeNextCronFireAt(definition: Extract<Automation.Definition, { kind: "recurring" }>, from: number) {
    if (definition.rhythm.kind !== "cron") return null
    const schedule = parseCronSchedule(definition.rhythm.expression)
    let cursor = DateTime.fromMillis(from, { zone: definition.timezone }).plus({ minutes: 1 }).startOf("minute")
    for (let attempts = 0; attempts < 527_040; attempts++) {
      if (cronMatches(schedule, cursor)) return cursor.toMillis()
      cursor = cursor.plus({ minutes: 1 })
    }
    return null
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
      return (
        left.timezone === right.timezone &&
        JSON.stringify(left.rhythm) === JSON.stringify(right.rhythm) &&
        JSON.stringify(left.stop) === JSON.stringify(right.stop)
      )
    }
    return false
  }

  export function make(options: Options = {}): Interface {
    const clock = options.clock ?? liveClock
    const executor = options.executor ?? sessionPromptExecutor
    const runtime = options.runtime ?? liveRuntime
    const ownerKey = options.ownerKey
    const ownerRetryMs = options.ownerRetryMs ?? 5_000
    const ownerRescanMs = options.ownerRescanMs ?? 5_000
    const tasks = new Map<string, ScheduledTask>()
    const ownedRuns = new Map<string, string>()
    const schedulerStoppedRuns = new Set<string>()
    let ownsTimers = !ownerKey
    let ownerLease: Flock.Lease | undefined
    let ownerAttempt: Promise<void> | undefined
    let ownerRetryTimer: ReturnType<typeof setInterval> | undefined
    let ownerRescanTimer: ReturnType<typeof setInterval> | undefined
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
        if (latest.kind === "recurring" && !latest.paused && canScheduleRecurring(latest)) {
          const next =
            latest.rhythm.kind === "interval" ? clock.now() + latest.rhythm.everyMs : computeNextFireAt(latest, clock.now())
          if (next === null) cancel(automationID)
          else schedule(latest, next)
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
        if (latest.kind === "recurring" && !canScheduleRecurring(latest)) return
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
        const latest = Automation.get(automationID)
        if (latest.kind === "recurring" && latest.rhythm.kind === "cron") scheduleNextInterval(automationID)
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
      if (!running || !ownsTimers || definition.paused) return
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
      if (!ownsTimers) return
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

    const scan = () => {
      if (!running || !ownsTimers) return
      for (const definition of Automation.list()) reschedule(definition)
    }

    const becomeOwner = async () => {
      if (!running || !ownerKey || ownerLease) return
      const lease = await Flock.tryAcquire(ownerKey).catch(() => undefined)
      if (!lease || !running || ownerLease) {
        if (lease) await lease.release().catch(() => undefined)
        return
      }
      ownerLease = lease
      ownsTimers = true
      for (const run of Automation.reconcileInterruptedRuns({ now: clock.now() })) void Automation.publishRunUpdated(run)
      scan()
      ownerRescanTimer = setInterval(scan, ownerRescanMs)
      ownerRescanTimer.unref?.()
    }

    const settleOwner = () => {
      if (!ownerKey || ownerLease || !running) return Promise.resolve()
      ownerAttempt ??= becomeOwner().finally(() => {
        ownerAttempt = undefined
      })
      return ownerAttempt
    }

    if (ownerKey) {
      void settleOwner()
      ownerRetryTimer = setInterval(() => void settleOwner(), ownerRetryMs)
      ownerRetryTimer.unref?.()
    } else {
      scan()
    }

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
        if (ownerRetryTimer) clearInterval(ownerRetryTimer)
        if (ownerRescanTimer) clearInterval(ownerRescanTimer)
        unsubscribeRunUpdates()
        unsubscribeDefinitionUpdates()
        unsubscribeDefinitionDeletes()
        stopOwnedRuns()
        for (const automationID of [...tasks.keys()]) cancel(automationID)
        if (ownerLease) void ownerLease.release().catch(() => undefined)
      },
      stopOwnedRuns,
      settleOwner,
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
      const state = { context, scheduler: make({ ownerKey: `automation-scheduler:${context.directory}` }) }
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
