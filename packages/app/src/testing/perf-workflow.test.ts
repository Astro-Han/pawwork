import fs from "node:fs/promises"
import { describe, expect, test } from "bun:test"

describe("perf workflow contract", () => {
  test("keeps default gate broad and low-end gate scoped", async () => {
    const workflow = await fs.readFile(new URL("../../../../.github/workflows/perf-probe-baseline.yml", import.meta.url), "utf8")

    expect(workflow).toContain("fetch-depth: 0")
    expect(workflow).toContain("Detect low-end perf scope")
    expect(workflow).toContain("PAWWORK_PERF_PROFILE: low-end")
    expect(workflow).toContain("perf-base-combined.json")
    expect(workflow).toContain("perf-head-combined.json")
    expect(workflow).toContain("perf-comment.md")
    expect(workflow.match(/perf-comment\.md/g)?.length).toBe(3)
  })
})
