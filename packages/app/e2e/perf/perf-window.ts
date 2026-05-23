export function createPerfWindowGuard() {
  let measuredWindowDepth = 0

  return {
    assertSetupAllowed(name: string) {
      if (measuredWindowDepth > 0) throw new Error(`${name} must run outside perf measured windows`)
    },

    async measure<T>(input: {
      reset: () => Promise<void>
      action: () => Promise<void>
      snapshot: () => Promise<T>
    }) {
      await input.reset()
      measuredWindowDepth += 1
      try {
        await input.action()
        return await input.snapshot()
      } finally {
        measuredWindowDepth -= 1
      }
    },
  }
}
