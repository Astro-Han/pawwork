import type { ServerHealth } from "@/utils/server-health"

export type ServerHealthToastDecision = {
  key: string
  failureCount: number
}

type ServerHealthToastPolicyInput = {
  activeKey: string | undefined
  results: Record<string, ServerHealth | undefined>
}

export function createServerHealthToastPolicy(options: { failureThreshold?: number } = {}) {
  const failureThreshold = Math.max(1, options.failureThreshold ?? 2)
  const failures = new Map<string, number>()

  return {
    update(input: ServerHealthToastPolicyInput): ServerHealthToastDecision[] {
      const activeKey = input.activeKey
      for (const key of [...failures.keys()]) {
        if (key !== activeKey || input.results[key]?.healthy !== false) failures.delete(key)
      }

      if (!activeKey || input.results[activeKey]?.healthy !== false) return []

      const failureCount = (failures.get(activeKey) ?? 0) + 1
      failures.set(activeKey, failureCount)
      return failureCount >= failureThreshold ? [{ key: activeKey, failureCount }] : []
    },
    failureCount(key: string) {
      return failures.get(key) ?? 0
    },
  }
}
