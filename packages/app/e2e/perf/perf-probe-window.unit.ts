import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

const specPath = new URL("./perf-probe.spec.ts", import.meta.url)

async function readPerfProbeSpec() {
  return fs.readFile(specPath, "utf8")
}

function extractMeasuredWindows(source: string) {
  const resetPattern = "await resetPerfProbe(page)"
  const snapshotPattern = "snapshotPerfProbe(page)"
  const windows: string[] = []
  let cursor = 0

  while (true) {
    const resetIndex = source.indexOf(resetPattern, cursor)
    if (resetIndex === -1) break
    const snapshotIndex = source.indexOf(snapshotPattern, resetIndex)
    if (snapshotIndex === -1) break
    windows.push(source.slice(resetIndex, snapshotIndex + snapshotPattern.length))
    cursor = snapshotIndex + snapshotPattern.length
  }

  return windows
}

function extractFunction(source: string, name: string) {
  const signatureIndex = source.indexOf(`function ${name}`)
  expect(signatureIndex).toBeGreaterThanOrEqual(0)

  const bodyStart = source.indexOf("{", signatureIndex)
  expect(bodyStart).toBeGreaterThanOrEqual(0)

  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index]
    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) return source.slice(signatureIndex, index + 1)
    }
  }

  throw new Error(`Could not parse function ${name}`)
}

describe("perf probe measured windows", () => {
  test("keep setup-only timeline scroll jumps outside measured windows", async () => {
    const source = await readPerfProbeSpec()
    const violations = extractMeasuredWindows(source).filter((window) =>
      window.includes("setTimelineScrollTopForSetup(page"),
    )

    expect(violations).toEqual([])
  })

  test("reject setup-only timeline scroll jumps while a measured window is active", async () => {
    const source = await readPerfProbeSpec()
    const measurePerfWindow = extractFunction(source, "measurePerfWindow")
    const setupScroll = extractFunction(source, "setTimelineScrollTopForSetup")

    expect(measurePerfWindow).toContain("measuredPerfWindowDepth += 1")
    expect(measurePerfWindow).toContain("return await snapshotPerfProbe(page)")
    expect(measurePerfWindow).toContain("measuredPerfWindowDepth -= 1")
    expect(setupScroll).toContain("if (measuredPerfWindowDepth > 0)")
  })

  test("name direct timeline scroll helper as setup-only", async () => {
    const source = await readPerfProbeSpec()

    expect(source).not.toContain("function scrollTimelineTo")
    expect(source).toContain("function setTimelineScrollTopForSetup")
  })
})
