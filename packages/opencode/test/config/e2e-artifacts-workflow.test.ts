import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parseWorkflow, readWorkflow } from "../github/workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "e2e-artifacts.yml")

describe("e2e artifacts workflow", () => {
  test("defines a required PR e2e workflow with retained failure artifacts", () => {
    const workflow = readWorkflow(workflowPath)
    const parsed = parseWorkflow(workflowPath)
    const changes = parsed.jobs?.changes
    const job = parsed.jobs?.["e2e-artifacts"]
    const checkJob = parsed.jobs?.check
    const changesSteps = changes?.steps ?? []
    const steps = job?.steps ?? []
    const checkSteps = checkJob?.steps ?? []
    const changesCheckoutStep = changesSteps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const filterStep = changesSteps.find((step) => step.id === "filter")
    const checkoutStep = steps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const bunStep = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
    const playwrightCacheStep = steps.find(
      (step) => step.uses?.startsWith("actions/cache@") && step.with?.path === "${{ github.workspace }}/.playwright-browsers",
    )
    const installBrowsersStep = steps.find((step) => step.name === "Install Playwright browsers")
    const runStep = steps.find((step) => step.name === "Run e2e")
    const warnStep = steps.find((step) => step.name === "Warn on E2E failure")
    const uploadStep = steps.find((step) => step.name === "Upload e2e artifacts")
    const validateStep = checkSteps.find((step) => step.name === "Validate e2e-artifacts result")

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
    expect(Object.keys(parsed.jobs ?? {}).sort()).toEqual(["changes", "check", "e2e-artifacts"])
    expect(changes?.outputs).toEqual({ docs_only: "${{ steps.filter.outputs.docs_only }}" })
    expect(changesCheckoutStep?.with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    })
    expect(filterStep?.env?.EVENT_NAME).toBe("${{ github.event_name }}")
    expect(filterStep?.run).toContain(".github/ISSUE_TEMPLATE/*")
    expect(filterStep?.run).toContain(".github/pull_request_template.md")
    expect(filterStep?.run).toContain("git diff --name-status --find-renames --find-copies")
    expect(filterStep?.run).toContain("R*|C*)")
    expect(job?.needs).toBe("changes")
    expect(job?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(job?.["runs-on"]).toBe("ubuntu-latest")
    expect(job?.["continue-on-error"]).not.toBe(true)
    expect(checkoutStep?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")
    expect(checkoutStep?.with).toEqual({ "persist-credentials": false })
    expect(bunStep?.uses).toBe("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")
    expect(playwrightCacheStep?.with?.key).toBe(
      "playwright-${{ runner.os }}-${{ hashFiles('packages/app/package.json', 'bun.lock') }}",
    )
    expect(playwrightCacheStep?.with?.["restore-keys"]).toBe("playwright-${{ runner.os }}-")
    expect(installBrowsersStep?.["timeout-minutes"]).toBe(5)
    expect(installBrowsersStep?.run).toBe("bunx playwright install --with-deps chromium")
    expect(runStep?.run).toContain("bun --cwd packages/app test:e2e:local:smoke")
    expect(runStep?.["continue-on-error"]).not.toBe(true)
    expect(warnStep?.if).toBe("failure()")
    expect(warnStep?.run).toContain("::warning::")
    expect(warnStep?.run).not.toContain("Non-blocking")
    expect(uploadStep?.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
    expect(uploadStep?.if).toBe("always()")
    expect(uploadStep?.with?.name).toBe("e2e-artifacts-linux-${{ github.run_attempt }}")
    expect(uploadStep?.with?.["if-no-files-found"]).toBe("ignore")
    expect(uploadStep?.with?.["retention-days"]).toBe(7)
    // check aggregator job assertions
    expect(checkJob?.if).toBe("always()")
    expect(checkJob?.needs).toEqual(["changes", "e2e-artifacts"])
    expect(checkJob?.["runs-on"]).toBe("ubuntu-latest")
    expect(validateStep?.env?.DOCS_ONLY).toBe("${{ needs.changes.outputs.docs_only }}")
    expect(validateStep?.env?.E2E_RESULT).toBe("${{ needs.e2e-artifacts.result }}")
    expect(validateStep?.run).toContain("if [ \"$DOCS_ONLY\" = \"true\" ]")
    expect(validateStep?.run).toContain("if [ \"$E2E_RESULT\" != \"success\" ]")
    expect(workflow).not.toContain("pull_request_target:")
    expect(workflow).not.toMatch(/\/Users\/[^/]+\//)
    expect(workflow).not.toMatch(/\/home\/[^/]+\//)
    expect(workflow).toContain("bun install --frozen-lockfile")
    expect(workflow).toContain("packages/app/e2e/playwright-report")
    expect(workflow).toContain("packages/app/e2e/test-results")
    expect(workflow).toContain("packages/app/e2e/junit-linux.xml")
  })
})
