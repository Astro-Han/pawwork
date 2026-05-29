import { Context, Effect, Layer } from "effect"
import { Automation } from "."
import { sessionPromptExecutor } from "./runner"

export namespace AutomationScheduler {
  const MAX_TIMER_DELAY_MS = 2_147_483_647

  export interface Clock {
    now(): number
    setTimer(delayMs: number, callback: () => void): () => void
  }

  export interface Interface {
    stop(): void
    reschedule(definition: Automation.Definition): void
    cancel(automationID: string): void
    nextFireAt(definition: Automation.Definition, from?: number): number | null
  }

  export interface Options {
    clock?: Clock
    executor?: Automation.RunExecutor
  }

  export const liveClock: Clock = {
    now: () => Date.now(),
    setTimer: (delayMs, callback) => {
      const id = setTimeout(callback, delayMs)
      id.unref?.()
      return () => clearTimeout(id)
    },
  }

  export class Service extends Context.Service<Service, Interface>()("@pawwork/AutomationScheduler") {}

  export const layer = (options?: Options) => Layer.effect(Service, Effect.sync(() => Service.of(make(options))))
  export const defaultLayer = layer()

  export function nextFireAt(definition: Automation.Definition, from: number): number | null {
    if (definition.paused) return null
    if (definition.kind === "oneshot") return definition.fireAt
    if (definition.rhythm.kind !== "interval") return null
    return from + definition.rhythm.everyMs
  }

  export function make(options: Options = {}): Interface {
    const clock = options.clock ?? liveClock
    const executor = options.executor ?? sessionPromptExecutor
    const timers = new Map<string, () => void>()
    let running = true

    const cancel = (automationID: string) => {
      const clear = timers.get(automationID)
      if (!clear) return
      clear()
      timers.delete(automationID)
    }

    const fire = (automationID: string, triggeredAt: number) => {
      timers.delete(automationID)
      if (Automation.hasActiveRun(automationID)) {
        const stopped = Automation.recordStoppedRun(automationID, "previous_run_awaiting_input", { now: triggeredAt })
        void Automation.publishRunUpdated(stopped)
        return
      }
      Automation.runNowExecuting(automationID, {
        executor: async (input) => {
          try {
            return await executor(input)
          } finally {
            const latest = Automation.get(input.definition.id)
            if (latest.kind === "recurring" && latest.rhythm.kind === "interval" && !latest.paused) {
              schedule(latest, clock.now() + latest.rhythm.everyMs)
            }
          }
        },
        attendance: "unattended",
        now: triggeredAt,
      })
    }

    const schedule = (definition: Automation.Definition, fireAt: number) => {
      cancel(definition.id)
      if (!running || definition.paused) return
      const delayMs = Math.max(0, fireAt - clock.now())
      const waitMs = Math.min(delayMs, MAX_TIMER_DELAY_MS)
      timers.set(
        definition.id,
        clock.setTimer(waitMs, () => {
          if (clock.now() < fireAt) {
            schedule(definition, fireAt)
            return
          }
          fire(definition.id, fireAt)
        }),
      )
    }

    const reschedule = (definition: Automation.Definition) => {
      const next = nextFireAt(definition, clock.now())
      if (next === null) {
        cancel(definition.id)
        return
      }
      schedule(definition, next)
    }

    return {
      stop() {
        running = false
        for (const automationID of [...timers.keys()]) cancel(automationID)
      },
      reschedule,
      cancel,
      nextFireAt(definition, from = clock.now()) {
        return nextFireAt(definition, from)
      },
    }
  }
}
