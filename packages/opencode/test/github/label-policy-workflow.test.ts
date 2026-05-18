import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parseWorkflow, readWorkflow } from "./workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "label-policy.yml")

describe("label policy workflow", () => {
  test("validates current labels instead of labeled event snapshots", () => {
    const workflow = readWorkflow(workflowPath)
    const parsed = parseWorkflow(workflowPath)
    const job = parsed.jobs?.["label-policy"]
    const steps = job?.steps ?? []
    const scriptStep = steps.find((step) => step.uses?.startsWith("actions/github-script@"))

    expect(parsed.name).toBe("label-policy")
    expect(parsed.on?.pull_request_target).toEqual({
      types: ["opened", "labeled", "unlabeled", "reopened"],
      branches: ["dev"],
    })
    expect(parsed.on?.issues).toBeUndefined()
    expect(parsed.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    })
    expect(scriptStep?.uses).toBe("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3")
    expect(workflow).toContain("github.rest.issues.listLabelsOnIssue")
    expect(workflow).toContain("issue_number: item.number")
    expect(workflow).toContain("const labels = currentLabels.map((label) => label.name)")
    expect(workflow).not.toContain("const labels = item.labels.map((label) => label.name)")
  })
})
