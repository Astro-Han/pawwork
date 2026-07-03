import { describe, expect, test } from "bun:test"
import { createServerHealthToastPolicy } from "./connection-health-policy"

describe("createServerHealthToastPolicy", () => {
  test("waits for consecutive active-server failures before alerting", () => {
    const policy = createServerHealthToastPolicy({ failureThreshold: 2 })

    expect(policy.update({ activeKey: "sidecar", results: { sidecar: { healthy: false } } })).toEqual([])
    expect(policy.update({ activeKey: "sidecar", results: { sidecar: { healthy: false } } })).toEqual([
      { key: "sidecar", failureCount: 2 },
    ])
  })

  test("ignores inactive server failures for toast decisions", () => {
    const policy = createServerHealthToastPolicy({ failureThreshold: 2 })

    policy.update({
      activeKey: "sidecar",
      results: {
        sidecar: { healthy: true },
        "https://old.example.test": { healthy: false },
      },
    })

    expect(
      policy.update({
        activeKey: "sidecar",
        results: {
          sidecar: { healthy: true },
          "https://old.example.test": { healthy: false },
        },
      }),
    ).toEqual([])
  })

  test("tracks inactive server failure counts for diagnostics", () => {
    const policy = createServerHealthToastPolicy({ failureThreshold: 2 })

    policy.update({
      activeKey: "sidecar",
      results: {
        sidecar: { healthy: true },
        "https://old.example.test": { healthy: false },
      },
    })
    expect(policy.failureCount("https://old.example.test")).toBe(1)

    policy.update({
      activeKey: "sidecar",
      results: {
        sidecar: { healthy: true },
        "https://old.example.test": { healthy: false },
      },
    })

    expect(policy.failureCount("https://old.example.test")).toBe(2)
  })

  test("resets active-server failure count after recovery", () => {
    const policy = createServerHealthToastPolicy({ failureThreshold: 2 })

    policy.update({ activeKey: "sidecar", results: { sidecar: { healthy: false } } })
    policy.update({ activeKey: "sidecar", results: { sidecar: { healthy: true } } })

    expect(policy.update({ activeKey: "sidecar", results: { sidecar: { healthy: false } } })).toEqual([])
  })
})
