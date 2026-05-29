import { describe, expect, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { contextUsageRingPercent, contextUsageTone } from "./session-context-usage-state"

const SOURCE_PATH = path.join(__dirname, "session-context-usage.tsx")

describe("session context usage indicator helpers", () => {
  test("uses normal tone for unknown usage and usage below warning", () => {
    expect(contextUsageTone(null)).toBe("normal")
    expect(contextUsageTone(69.9)).toBe("normal")
  })

  test("uses warning and danger thresholds", () => {
    expect(contextUsageTone(70)).toBe("warning")
    expect(contextUsageTone(89.9)).toBe("warning")
    expect(contextUsageTone(90)).toBe("danger")
  })

  test("clamps only ring drawing percentage", () => {
    expect(contextUsageRingPercent(null)).toBe(0)
    expect(contextUsageRingPercent(-1)).toBe(0)
    expect(contextUsageRingPercent(42.5)).toBe(42.5)
    expect(contextUsageRingPercent(120)).toBe(100)
  })
})

describe("SessionContextUsage render contract", () => {
  test("does not pass volatile context accessors through non-keyed Show children", async () => {
    const source = await fs.readFile(SOURCE_PATH, "utf8")

    expect(source).not.toContain("<Show when={context()}>")
    expect(source).not.toContain("<Show when={compactStatus()}>{(status)")
  })
})
