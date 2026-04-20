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
    const job = jobs["analyze-js-ts"]
    const steps = job?.steps ?? []

    expect(parsed.name).toBe("codeql")
    expect(parsed.on?.push).toEqual({ branches: ["dev"] })
    expect(parsed.on?.pull_request).toEqual({ branches: ["dev"] })
    expect(parsed.on?.schedule).toEqual([{ cron: "0 2 * * 1" }])
    expect(parsed.on?.workflow_dispatch).toBeUndefined()
    expect(parsed.permissions).toEqual({
      actions: "read",
      contents: "read",
      "security-events": "write",
    })
    expect(Object.keys(jobs)).toEqual(["analyze-js-ts"])
    expect(Object.keys(job ?? {}).sort()).toEqual(["runs-on", "steps", "timeout-minutes"])
    expect(job?.["runs-on"]).toBe("ubuntu-latest")
    expect(job?.["timeout-minutes"]).toBe(30)
    expect(steps).toHaveLength(3)
    expect(steps.map((step) => ({ name: step.name, uses: step.uses }))).toEqual([
      {
        name: undefined,
        uses: "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
      },
      {
        name: "Initialize CodeQL",
        uses: "github/codeql-action/init@95e58e9a2cdfd71adc6e0353d5c52f41a045d225",
      },
      {
        name: "Analyze with CodeQL",
        uses: "github/codeql-action/analyze@95e58e9a2cdfd71adc6e0353d5c52f41a045d225",
      },
    ])

    expect(steps[0]?.with).toEqual({ "persist-credentials": false })
    expect(steps[1]?.with).toEqual({ languages: "javascript-typescript" })
    expect(steps[2]?.with).toEqual({ category: "/language:javascript-typescript" })
    expect(steps.every((step) => step.run === undefined && step.env === undefined)).toBe(true)

    expect(workflow).toContain("group: codeql-${{ github.ref }}")
    expect(workflow).toContain("cancel-in-progress: true")
    expect(workflow).not.toContain("pull_request_target")
    expect(workflow).not.toContain("persist-credentials: true")
    expect(workflow).not.toContain("strategy:")
    expect(workflow).not.toContain("matrix:")
    expect(workflow).not.toContain("autobuild")
    expect(workflow).not.toContain("secrets.")
  })
})
