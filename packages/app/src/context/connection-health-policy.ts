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
        if (!(key in input.results) || input.results[key]?.healthy !== false) failures.delete(key)
      }
      for (const [key, result] of Object.entries(input.results)) {
        if (result?.healthy === false) failures.set(key, (failures.get(key) ?? 0) + 1)
      }

      if (!activeKey || input.results[activeKey]?.healthy !== false) return []

      const failureCount = failures.get(activeKey) ?? 0
      return failureCount >= failureThreshold ? [{ key: activeKey, failureCount }] : []
    },
    failureCount(key: string) {
      return failures.get(key) ?? 0
    },
  }
}
