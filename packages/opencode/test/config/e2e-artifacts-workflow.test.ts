import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parseWorkflow, readWorkflow } from "../github/workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "e2e-artifacts.yml")

describe("e2e artifacts workflow", () => {
  test("defines a visible but non-blocking PR diagnostics workflow", () => {
    const workflow = readWorkflow(workflowPath)
    const parsed = parseWorkflow(workflowPath)
    const job = parsed.jobs?.["e2e-artifacts"]
    const steps = job?.steps ?? []
    const checkoutStep = steps.find((step) => step.uses === "actions/checkout@v4")
    const bunStep = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
    const installBrowsersStep = steps.find((step) => step.name === "Install Playwright browsers")
    const runStep = steps.find((step) => step.name === "Run e2e")
    const warnStep = steps.find((step) => step.name === "Warn on smoke failure")
    const uploadStep = steps.find((step) => step.name === "Upload e2e artifacts")

    expect(parsed.name).toBe("e2e-artifacts")
    expect(parsed.on?.pull_request).toEqual({ branches: ["dev"] })
    expect(parsed.on?.workflow_dispatch).toEqual({
      inputs: {
        suite: {
          description: "E2E suite to run",
          required: true,
          default: "full",
          type: "choice",
          options: ["full", "smoke"],
        },
      },
    })
    expect(workflow).toContain(
      "group: e2e-artifacts-${{ github.event.pull_request.number || github.ref }}-${{ inputs.suite || 'pr-smoke' }}",
    )
    expect(parsed.permissions).toEqual({ contents: "read" })
    expect(job?.["runs-on"]).toBe("ubuntu-latest")
    expect(job?.["continue-on-error"]).toBe(true)
    expect(checkoutStep?.with).toEqual({ "persist-credentials": false })
    expect(bunStep?.uses).toBe("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")
    expect(installBrowsersStep?.run).toBe("bunx playwright install --with-deps chromium")
    expect(runStep?.run).toContain("bun --cwd packages/app test:e2e:local:smoke")
    expect(warnStep?.if).toBe("failure()")
    expect(warnStep?.run).toContain("::warning::")
    expect(uploadStep?.uses).toBe("actions/upload-artifact@v4")
    expect(uploadStep?.with?.name).toBe("e2e-artifacts-linux-${{ github.run_attempt }}")
    expect(uploadStep?.with?.["if-no-files-found"]).toBe("ignore")
    expect(uploadStep?.with?.["retention-days"]).toBe(7)
    expect(workflow).not.toContain("pull_request_target:")
    expect(workflow).not.toMatch(/\/Users\/[^/]+\//)
    expect(workflow).not.toMatch(/\/home\/[^/]+\//)
    expect(workflow).toContain("bun install --frozen-lockfile")
    expect(workflow).toContain("packages/app/e2e/playwright-report")
    expect(workflow).toContain("packages/app/e2e/test-results")
    expect(workflow).toContain("packages/app/e2e/junit-linux.xml")
  })
})
