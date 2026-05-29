import { describe, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseWorkflow, readWorkflow } from "./workflow-parser"

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url))
const workflowPath = path.join(repoRoot, ".github", "workflows", "perf-probe-baseline.yml")

const pinned = {
  cacheRestore: "actions/cache/restore@27d5ce7f107fe9357f9df03efb73ab90386fccae",
  checkout: "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
}

describe("perf probe baseline workflow", () => {
  test("uses read-only permissions and restore-only caches", () => {
    const workflow = readWorkflow(workflowPath)
    const parsed = parseWorkflow(workflowPath)
    const job = parsed.jobs?.["perf-probe-baseline"]
    const steps = job?.steps ?? []
    const cacheSteps = steps.filter((step) => step.uses?.startsWith("actions/cache"))

    expect(parsed.name).toBe("perf-probe-baseline")
    expect(parsed.permissions).toEqual({ contents: "read" })
    expect(cacheSteps.map((step) => step.uses)).toEqual([pinned.cacheRestore, pinned.cacheRestore])
    expect(cacheSteps.map((step) => step.with?.path)).toEqual([
      "~/.bun/install/cache",
      "${{ github.workspace }}/.playwright-browsers",
    ])
    expect(workflow).not.toContain("issues: write")
    expect(workflow).not.toContain("pull-requests: write")
    expect(workflow).not.toContain("actions/github-script")
    expect(workflow).not.toContain("github.rest.issues")
  })

  test("uses system Chrome instead of downloading Playwright browsers", () => {
    const workflow = readWorkflow(workflowPath)
    const parsed = parseWorkflow(workflowPath)
    const job = parsed.jobs?.["perf-probe-baseline"]
    const steps = job?.steps ?? []
    const installBrowsers = steps.find((step) => step.name === "Install Playwright system dependencies")
    const perfSteps = steps.filter((step) => step.run?.includes("test:e2e:local:perf"))
    const runtimeClsStep = steps.find((step) => step.name === "Run runtime CLS gate (head)")

    expect(installBrowsers?.["timeout-minutes"]).toBe(10)
    expect(installBrowsers?.["working-directory"]).toBe("head/packages/app")
    expect(installBrowsers?.run).toContain("bunx playwright install-deps chromium")
    expect(installBrowsers?.run).toContain("google-chrome --version")
    expect(installBrowsers?.run).not.toContain("playwright install --with-deps chromium")
    expect(workflow).not.toContain("Install Playwright browsers")
    expect(job?.env?.PLAYWRIGHT_VIDEO).toBe("off")

    for (const step of perfSteps) {
      expect(step.env?.PLAYWRIGHT_BROWSER_CHANNEL).toBe("chrome")
    }
    expect(runtimeClsStep?.env?.PLAYWRIGHT_BROWSER_CHANNEL).toBe("chrome")
  })

  test("checks out base at the computed merge-base and skips base-only steps when the range is unavailable", () => {
    const parsed = parseWorkflow(workflowPath)
    const steps = parsed.jobs?.["perf-probe-baseline"]?.steps ?? []
    const headCheckout = steps.find((step) => step.with?.path === "head")
    const fetchBase = steps.find((step) => step.name === "Fetch pull request base")
    const computeRange = steps.find((step) => step.name === "Compute SHA range")
    const baseCheckout = steps.find((step) => step.with?.path === "base")
    const skipNotice = steps.find((step) => step.name === "Skip perf probe without a comparable base")
    const baseOnlyStepNames = [
      "Install base dependencies",
      "Sync perf harness into base checkout",
      "Run perf probe baseline (base)",
      "Run low-end perf probe baseline (base)",
      "Confirm perf regression (base)",
      "Confirm low-end perf regression (base)",
    ]

    expect(headCheckout?.uses).toBe(pinned.checkout)
    expect(headCheckout?.with?.["fetch-depth"]).toBe(0)
    expect(fetchBase?.if).toBe("github.event_name == 'pull_request'")
    expect(fetchBase?.["working-directory"]).toBe("head")
    expect(fetchBase?.run).toContain("refs/remotes/origin/${{ github.event.pull_request.base.ref }}")
    expect(computeRange?.id).toBe("compute-range")
    expect(computeRange?.["working-directory"]).toBe("head")
    expect(computeRange?.run).toContain("git merge-base")
    expect(computeRange?.run).toContain("skipped=true")
    expect(baseCheckout?.uses).toBe(pinned.checkout)
    expect(baseCheckout?.if).toBe("steps.compute-range.outputs.skipped != 'true' && env.BASE_SHA != ''")
    expect(baseCheckout?.with?.ref).toBe("${{ steps.compute-range.outputs.base_sha }}")
    expect(skipNotice?.if).toBe("steps.compute-range.outputs.skipped == 'true' || env.BASE_SHA == ''")
    expect(skipNotice?.run).toContain("No comparable base SHA")

    for (const name of baseOnlyStepNames) {
      expect(steps.find((step) => step.name === name)?.if).toContain("steps.compute-range.outputs.skipped != 'true'")
    }
  })
})
