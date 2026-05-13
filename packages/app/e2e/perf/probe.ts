import type { Page } from "@playwright/test"
import { aggregatePerfRuns, summarizePerfRun, type PerfRunSummary } from "../../src/testing/perf-metrics"

type BrowserPerfSample = {
  startedAt: number
  endedAt: number
  interactions: Array<{ at: number; delay: number; duration: number }>
  longTasks: Array<{ at: number; duration: number }>
  frames: Array<{ at: number; duration: number }>
  shifts: Array<{ at: number; value: number }>
  fcpMs?: number
  lcpMs?: number
  heapUsedMb?: number
}

type BrowserPerfWindow = Window & {
  __pawwork_perf_probe?: {
    reset: (label?: string) => void
    snapshot: () => BrowserPerfSample
  }
}

export async function installPerfProbe(page: Page) {
  await page.addInitScript(() => {
    const win = window as BrowserPerfWindow
    if (win.__pawwork_perf_probe) return

    const interactions: Array<{ at: number; delay: number; duration: number }> = []
    const longTasks: Array<{ at: number; duration: number }> = []
    const frames: Array<{ at: number; duration: number }> = []
    const shifts: Array<{ at: number; value: number }> = []
    const maxEntries = 4000
    const supported = PerformanceObserver.supportedEntryTypes ?? []
    let startedAt = 0
    let raf = 0
    let lastFrame = 0
    let fcpMs: number | undefined
    let lcpMs: number | undefined

    const trim = <T,>(list: T[]) => {
      if (list.length <= maxEntries) return
      list.splice(0, list.length - maxEntries)
    }

    const observe = (
      type: string,
      init: PerformanceObserverInit & { durationThreshold?: number },
      fn: (entries: PerformanceEntry[]) => void,
    ) => {
      if (!supported.includes(type)) return
      const observer = new PerformanceObserver((list) => fn(list.getEntries()))
      try {
        observer.observe(init)
      } catch {
        observer.disconnect()
      }
    }

    observe("event", { buffered: true, durationThreshold: 16, type: "event" }, (entries) => {
      for (const entry of entries as Array<PerformanceEntry & { processingStart?: number }>) {
        if (entry.duration < 16) continue
        interactions.push({
          at: entry.startTime,
          delay: Math.max(0, (entry.processingStart ?? entry.startTime) - entry.startTime),
          duration: entry.duration,
        })
      }
      trim(interactions)
    })

    observe("longtask", { buffered: true, type: "longtask" }, (entries) => {
      for (const entry of entries) {
        longTasks.push({ at: entry.startTime, duration: entry.duration })
      }
      trim(longTasks)
    })

    observe("layout-shift", { buffered: true, type: "layout-shift" }, (entries) => {
      for (const entry of entries as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>) {
        if (entry.hadRecentInput) continue
        if (typeof entry.value !== "number") continue
        shifts.push({ at: entry.startTime, value: entry.value })
      }
      trim(shifts)
    })

    observe("paint", { buffered: true, type: "paint" }, (entries) => {
      for (const entry of entries) {
        if (entry.name === "first-contentful-paint") {
          fcpMs = entry.startTime
        }
      }
    })

    observe("largest-contentful-paint", { buffered: true, type: "largest-contentful-paint" }, (entries) => {
      for (const entry of entries) {
        lcpMs = entry.startTime
      }
    })

    const loop = (at: number) => {
      if (document.visibilityState === "visible") {
        if (lastFrame !== 0) {
          frames.push({ at, duration: at - lastFrame })
          trim(frames)
        }
        lastFrame = at
      } else {
        lastFrame = 0
      }
      raf = requestAnimationFrame(loop)
    }

    raf = requestAnimationFrame(loop)
    win.addEventListener("beforeunload", () => {
      if (raf !== 0) cancelAnimationFrame(raf)
    })

    win.__pawwork_perf_probe = {
      reset() {
        startedAt = performance.now()
      },
      snapshot() {
        const memory = performance as Performance & { memory?: { usedJSHeapSize?: number } }
        return {
          startedAt,
          endedAt: performance.now(),
          interactions: interactions.slice(),
          longTasks: longTasks.slice(),
          frames: frames.slice(),
          shifts: shifts.slice(),
          fcpMs,
          lcpMs,
          heapUsedMb:
            typeof memory.memory?.usedJSHeapSize === "number"
              ? memory.memory.usedJSHeapSize / 1024 / 1024
              : undefined,
        }
      },
    }
  })
}

export async function resetPerfProbe(page: Page, label?: string) {
  await page.evaluate((nextLabel) => {
    const probe = (window as BrowserPerfWindow).__pawwork_perf_probe
    if (!probe) throw new Error("Perf probe is not installed")
    probe.reset(nextLabel)
  }, label)
}

export async function snapshotPerfProbe(page: Page) {
  const sample = await page.evaluate(() => {
    const probe = (window as BrowserPerfWindow).__pawwork_perf_probe
    if (!probe) throw new Error("Perf probe is not installed")
    return probe.snapshot()
  })
  return summarizePerfRun(sample)
}

export function summarizeScenarioRuns(input: { branch: string; scenario: string; runs: PerfRunSummary[] }) {
  return aggregatePerfRuns(input)
}
