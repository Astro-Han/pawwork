import { describe, expect, test } from "vitest"

import { stapler, type StaplerResult } from "./stapler"

// The failure a macOS runner printed when CloudKit dropped the ticket lookup.
const connectionLost: StaplerResult = {
  status: 68,
  output:
    'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\nThe staple and validate action failed! Error 68.',
}
const notStapled: StaplerResult = { status: 65, output: "PawWork.app does not have a ticket stapled to it." }
const stapled: StaplerResult = { status: 0, output: "The staple and validate action worked!" }

function scripted(results: StaplerResult[]) {
  const calls: string[] = []
  const sleeps: number[] = []
  const run = (action: string, target: string) => {
    calls.push(`${action} ${target}`)
    return results[Math.min(calls.length, results.length) - 1]
  }
  return { calls, sleeps, options: { run, sleep: async (ms: number) => void sleeps.push(ms), log: () => {} } }
}

describe("stapler", () => {
  test("retries a dropped connection until the ticket lookup succeeds", async () => {
    const { calls, sleeps, options } = scripted([connectionLost, connectionLost, stapled])
    expect(await stapler("staple", "dist/mac/PawWork.app", options)).toBe(0)
    expect(calls).toEqual(Array(3).fill("staple dist/mac/PawWork.app"))
    expect(sleeps).toHaveLength(2)
  })

  test("fails at once when the bundle itself is the problem", async () => {
    const { calls, options } = scripted([notStapled, stapled])
    expect(await stapler("validate", "PawWork.app", options)).toBe(65)
    expect(calls).toHaveLength(1)
  })

  test("gives up with stapler's own status when the network never recovers", async () => {
    const { calls, options } = scripted([connectionLost])
    expect(await stapler("validate", "PawWork.app", options)).toBe(68)
    expect(calls).toHaveLength(6)
  })
})
