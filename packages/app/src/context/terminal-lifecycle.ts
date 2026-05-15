import type { RuntimePTY, RuntimePTYID, TerminalTabID } from "./terminal-types"

type CreateRuntimeInput = {
  title: string
}

type LifecycleOptions = {
  create: (input: CreateRuntimeInput) => Promise<RuntimePTY>
  remove: (ptyID: RuntimePTYID) => Promise<void>
}

type RuntimeEntry = {
  generation: number
  runtime?: RuntimePTY
  pending?: Promise<RuntimePTY | undefined>
}

export function createTerminalLifecycle(options: LifecycleOptions) {
  const entries = new Map<TerminalTabID, RuntimeEntry>()

  const entryFor = (tabID: TerminalTabID) => {
    const existing = entries.get(tabID)
    if (existing) return existing
    const entry: RuntimeEntry = { generation: 0 }
    entries.set(tabID, entry)
    return entry
  }

  const removeBestEffort = (ptyID: RuntimePTYID) => {
    void options.remove(ptyID).catch(() => undefined)
  }

  return {
    peek(tabID: TerminalTabID) {
      return entries.get(tabID)?.runtime
    },
    ensureLive(input: { tabID: TerminalTabID; title: string }) {
      const entry = entryFor(input.tabID)
      if (entry.runtime) return Promise.resolve(entry.runtime)
      if (entry.pending) return entry.pending

      const generation = entry.generation
      const pending = options
        .create({ title: input.title })
        .then((runtime) => {
          const latest = entries.get(input.tabID)
          if (latest !== entry || latest.generation !== generation || latest.pending !== pending) {
            removeBestEffort(runtime.ptyID)
            return undefined
          }
          entry.runtime = runtime
          return runtime
        })
        .finally(() => {
          if (entry.pending === pending) entry.pending = undefined
          if (!entry.runtime && !entry.pending) entries.delete(input.tabID)
        })

      entry.pending = pending
      return pending
    },
    markGone(tabID: TerminalTabID) {
      const entry = entries.get(tabID)
      if (!entry) return
      entry.generation += 1
      entry.runtime = undefined
      if (!entry.pending) entries.delete(tabID)
    },
    removeRuntime(tabID: TerminalTabID) {
      const entry = entries.get(tabID)
      if (!entry) return
      entry.generation += 1
      const runtime = entry.runtime
      entry.runtime = undefined
      entries.delete(tabID)
      if (runtime) removeBestEffort(runtime.ptyID)
    },
    clearRuntime() {
      for (const [tabID, entry] of entries) {
        entry.generation += 1
        const runtime = entry.runtime
        entry.runtime = undefined
        if (!entry.pending) entries.delete(tabID)
        if (runtime) removeBestEffort(runtime.ptyID)
      }
    },
  }
}
