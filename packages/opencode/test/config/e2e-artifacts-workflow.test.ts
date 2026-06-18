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
    const docsPathsStep = changesSteps.find((step) => step.id === "docs-paths")
    const codePathsStep = changesSteps.find((step) => step.id === "code-paths")
    const filterStep = changesSteps.find((step) => step.id === "filter")
    const checkoutStep = steps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const bunStep = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
    const playwrightCacheStep = steps.find(
      (step) => step.uses?.startsWith("actions/cache@") && step.with?.path === "${{ github.workspace }}/.playwright-browsers",
    )
    const chromeStep = steps.find((step) => step.name === "Verify GitHub-hosted Chrome")
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
    expect(parsed.permissions).toEqual({ contents: "read", "pull-requests": "read" })
    expect(Object.keys(parsed.jobs ?? {}).sort()).toEqual(["changes", "check", "e2e-artifacts"])
    expect(changes?.outputs).toEqual({ docs_only: "${{ steps.filter.outputs.docs_only }}" })
    expect(changesSteps.find((step) => step.uses?.startsWith("actions/checkout@"))).toBeUndefined()
    expect(docsPathsStep?.uses).toBe("dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d")
    expect(docsPathsStep?.with?.filters).toContain("docs:")
    expect(docsPathsStep?.with?.filters).toContain("'docs/**'")
    expect(codePathsStep?.uses).toBe("dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d")
    expect(codePathsStep?.if).toBe("github.event_name == 'pull_request' || github.event_name == 'push'")
    expect(codePathsStep?.["continue-on-error"]).toBe(true)
    expect(codePathsStep?.with?.["predicate-quantifier"]).toBe("every")
    expect(codePathsStep?.with?.filters).toContain("'!docs/**'")
    expect(codePathsStep?.with?.filters).not.toContain("*.md")
    expect(filterStep?.if).toBe("always()")
    expect(filterStep?.env?.EVENT_NAME).toBe("${{ github.event_name }}")
    expect(filterStep?.env?.DOCS_CHANGED).toBe("${{ steps.docs-paths.outputs.docs }}")
    expect(filterStep?.env?.CODE_CHANGED).toBe("${{ steps.code-paths.outputs.code }}")
    expect(filterStep?.run).toContain("docs_only=false")
    expect(filterStep?.run).toContain("docs_only=$docs_only")
    expect(job?.needs).toBe("changes")
    expect(job?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(job?.["runs-on"]).toBe("ubuntu-latest")
    expect(job?.["continue-on-error"]).not.toBe(true)
    expect(checkoutStep?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")
    expect(checkoutStep?.with).toEqual({ "persist-credentials": false })
    expect(bunStep?.uses).toBe("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")
    expect(playwrightCacheStep).toBeUndefined()
    expect(chromeStep?.["timeout-minutes"]).toBe(2)
    expect(chromeStep?.run).toBe("google-chrome --version")
    expect(workflow).not.toContain("PLAYWRIGHT_BROWSERS_PATH")
    expect(workflow).not.toContain("bunx playwright install")
    expect(workflow).not.toContain("run: playwright install")
    expect(runStep?.env?.PLAYWRIGHT_BROWSER_CHANNEL).toBe("chrome")
    expect(runStep?.env?.PLAYWRIGHT_VIDEO).toBe("off")
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
