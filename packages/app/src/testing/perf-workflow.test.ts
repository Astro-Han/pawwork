import fs from "node:fs/promises"
import { describe, expect, test } from "bun:test"

const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, "\n")

describe("perf workflow contract", () => {
  test("matches workflow snippets after Windows line-ending checkout", () => {
    const workflow = normalizeLineEndings("restore-keys: |\r\n            playwright-${{ runner.os }}-")

    expect(workflow).toContain("restore-keys: |\n            playwright-${{ runner.os }}-")
  })

  test("keeps default gate broad and low-end gate scoped", async () => {
    const workflow = normalizeLineEndings(
      await fs.readFile(new URL("../../../../.github/workflows/perf-probe-baseline.yml", import.meta.url), "utf8"),
    )

    expect(workflow).toContain("fetch-depth: 0")
    expect(workflow).toContain("permissions:\n  contents: read")
    expect(workflow).not.toContain("issues: write")
    expect(workflow).not.toContain("pull-requests: write")
    expect(workflow).not.toContain("actions/github-script")
    expect(workflow).toContain("Detect low-end perf scope")
    expect(workflow).toContain("PAWWORK_PERF_PROFILE: low-end")
    expect(workflow).toContain("bunx playwright install-deps chromium")
    expect(workflow).toContain("google-chrome --version")
    expect(workflow).toContain("PLAYWRIGHT_BROWSER_CHANNEL: chrome")
    expect(workflow).not.toContain("playwright install --with-deps chromium")
    expect(workflow).toContain("actions/cache/restore@")
    expect(workflow).toContain("restore-keys: |\n            playwright-${{ runner.os }}-")
    expect(workflow).toContain("perf-base-combined.json")
    expect(workflow).toContain("perf-head-combined.json")
    expect(workflow).toContain("perf-comment.md")
    expect(workflow.match(/perf-comment\.md/g)?.length).toBe(2)
  })
})
