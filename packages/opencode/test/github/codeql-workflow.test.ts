import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parseWorkflow, readWorkflow } from "./workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "codeql.yml")

describe("codeql workflow", () => {
  test("defines a JS/TS code scanning workflow for dev pushes, PRs, and weekly scans", () => {
    const workflow = readWorkflow(workflowPath)
    const parsed = parseWorkflow(workflowPath)
    const jobs = parsed.jobs ?? {}
    const changesJob = jobs.changes
    const changesSteps = changesJob?.steps ?? []
    const changesCheckoutStep = changesSteps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const pathsStep = changesSteps.find((step) => step.id === "paths")
    const changesFilterStep = changesSteps.find((step) => step.id === "filter")
    const job = jobs["analyze-js-ts"]
    const steps = job?.steps ?? []
    const checkoutStep = steps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const initStep = steps.find((step) => step.name === "Initialize CodeQL")
    const analyzeStep = steps.find((step) => step.name === "Analyze with CodeQL")

    expect(parsed.name).toBe("codeql")
    expect(parsed.on?.push).toEqual({ branches: ["dev"] })
    expect(parsed.on?.pull_request).toEqual({ branches: ["dev"] })
    expect(parsed.on?.schedule).toEqual([{ cron: "0 2 * * 1" }])
    expect(parsed.on?.workflow_dispatch).toBeUndefined()
    expect(parsed.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
      "security-events": "write",
    })
    expect(Object.keys(jobs)).toEqual(["changes", "analyze-js-ts"])
    expect(Object.keys(changesJob ?? {}).sort()).toEqual(["outputs", "runs-on", "steps"])
    expect(changesJob?.["runs-on"]).toBe("ubuntu-latest")
    expect(changesJob?.outputs).toEqual({ docs_only: "${{ steps.filter.outputs.docs_only }}" })
    expect(changesSteps).toHaveLength(3)
    expect(changesCheckoutStep?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")
    expect(changesCheckoutStep?.if).toBe("github.event_name == 'push'")
    expect(changesCheckoutStep?.with).toEqual({ "fetch-depth": 0, "persist-credentials": false })
    expect(pathsStep?.uses).toBe("dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d")
    expect(pathsStep?.if).toBe("github.event_name == 'pull_request' || github.event_name == 'push'")
    expect(pathsStep?.["continue-on-error"]).toBe(true)
    expect(pathsStep?.with?.["predicate-quantifier"]).toBe("every")
    expect(pathsStep?.with?.filters).toContain("code:")
    expect(pathsStep?.with?.filters).toContain("'!docs/**'")
    expect(changesFilterStep?.if).toBe("always()")
    expect(changesFilterStep?.env).toEqual({
      EVENT_NAME: "${{ github.event_name }}",
      BEFORE_SHA: "${{ github.event.before }}",
      PATHS_OUTCOME: "${{ steps.paths.outcome }}",
      CODE_CHANGED: "${{ steps.paths.outputs.code }}",
    })
    expect(changesFilterStep?.run).toContain("docs_only=$docs_only")

    expect(Object.keys(job ?? {}).sort()).toEqual(["if", "needs", "runs-on", "steps", "timeout-minutes"])
    expect(job?.needs).toBe("changes")
    expect(job?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(job?.["runs-on"]).toBe("ubuntu-latest")
    expect(job?.["timeout-minutes"]).toBe(30)
    expect(steps).toHaveLength(3)
    expect(checkoutStep?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")
    expect(initStep?.uses).toBe("github/codeql-action/init@68bde559dea0fdcac2102bfdf6230c5f70eb485e")
    expect(analyzeStep?.uses).toBe("github/codeql-action/analyze@68bde559dea0fdcac2102bfdf6230c5f70eb485e")

    expect(checkoutStep?.with).toEqual({ "persist-credentials": false })
    expect(initStep?.with).toEqual({ languages: "javascript-typescript" })
    expect(analyzeStep?.with).toEqual({ category: "/language:javascript-typescript" })
    expect(steps.every((step) => step.run === undefined && step.env === undefined)).toBe(true)

    expect(parsed.concurrency?.group).toContain("codeql-")
    expect(parsed.concurrency?.group).toContain("github.ref == 'refs/heads/dev'")
    expect(parsed.concurrency?.group).toContain("github.run_id")
    expect(parsed.concurrency?.group).toContain("github.event.pull_request.number || github.ref")
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe("${{ github.ref != 'refs/heads/dev' }}")
    expect(workflow).not.toContain("pull_request_target")
    expect(workflow).not.toContain("persist-credentials: true")
    expect(workflow).not.toContain("strategy:")
    expect(workflow).not.toContain("matrix:")
    expect(workflow).not.toContain("autobuild")
    expect(workflow).not.toContain("secrets.")
  })
})
