import { describe, expect, test } from "bun:test"
import path from "node:path"
import { validateLabelPolicy } from "../../../../.github/scripts/label-policy-check.js"
import {
  buildPriorityReview,
  classifyPriority,
  planPriorityLabels,
  TRIAGE_MARKER,
} from "../../../../.github/scripts/pr-priority-triage.js"
import { parseWorkflow, readWorkflow } from "./workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const labelerConfigPath = path.join(repoRoot, ".github", "labeler.yml")
const labelerWorkflowPath = path.join(repoRoot, ".github", "workflows", "labeler.yml")
const triageWorkflowPath = path.join(repoRoot, ".github", "workflows", "pr-priority-triage.yml")

type LabelerRule = {
  "changed-files"?: Array<{
    "any-glob-to-any-file"?: string[]
  }>
}

type LabelerConfig = Record<string, LabelerRule[]>

function labelerLabelsForGlob(glob: string) {
  const config = parseWorkflow(labelerConfigPath) as unknown as LabelerConfig
  return Object.entries(config)
    .filter(([, rules]) =>
      rules.some((rule) =>
        rule["changed-files"]?.some((changedFilesRule) =>
          changedFilesRule["any-glob-to-any-file"]?.includes(glob),
        ),
      ),
    )
    .map(([label]) => label)
}

describe("pr routing workflows", () => {
  test("defines labeler routing for repo areas and workflow policy labels", () => {
    const config = readWorkflow(labelerConfigPath)
    expect(config).toContain("ci:")
    expect(config).toContain("task:")
    expect(config).not.toContain("P3:")
    expect(config).toContain("platform:")
    expect(config).toContain("app:")
    expect(config).toContain("ui:")
    expect(config).toContain("harness:")
    expect(config).not.toContain("documentation:")
    expect(config).toContain(".github/workflows/**")
    expect(config).toContain("packages/desktop-electron/**")
    expect(config).toContain("packages/app/**")
    expect(config).toContain("packages/opencode/**")
    expect(config).toContain("**/*.tsx")
    expect(config).not.toContain("**/*.md")
  })

  test("labels workflow PRs with type and routing while priority triage owns priority", () => {
    const labels = labelerLabelsForGlob(".github/workflows/**")

    expect(new Set(labels)).toEqual(new Set(["ci", "task"]))
    expect(validateLabelPolicy({ itemType: "pull_request", labels: [...labels, "P3"] }).ok).toBe(true)
  })

  test("pins labeler and triage workflow contracts", () => {
    const labelerWorkflow = readWorkflow(labelerWorkflowPath)
    const labelerParsed = parseWorkflow(labelerWorkflowPath)
    const labelerSteps = labelerParsed.jobs?.labeler?.steps ?? []
    const labelerStep = labelerSteps[0]

    expect(labelerParsed.name).toBe("labeler")
    expect(labelerParsed.on?.pull_request_target).toEqual({
      types: ["opened", "synchronize", "reopened"],
      branches: ["dev"],
    })
    expect(labelerParsed.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
    })
    expect(labelerStep?.uses).toBe("actions/labeler@f27b608878404679385c85cfa523b85ccb86e213")
    expect(labelerStep?.with).toEqual({ "sync-labels": true })
    expect(labelerWorkflow).not.toContain("persist-credentials: true")

    const triageWorkflow = readWorkflow(triageWorkflowPath)
    const triageParsed = parseWorkflow(triageWorkflowPath)
    const triageSteps = triageParsed.jobs?.["pr-priority-triage"]?.steps ?? []
    const checkout = triageSteps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const script = triageSteps.find((step) => step.uses?.startsWith("actions/github-script@"))

    expect(triageParsed.name).toBe("pr-priority-triage")
    expect(triageParsed.on?.pull_request_target).toEqual({
      types: ["opened", "synchronize", "reopened"],
      branches: ["dev"],
    })
    expect(triageParsed.permissions).toEqual({
      contents: "read",
      issues: "write",
      "pull-requests": "write",
    })
    expect(triageParsed.concurrency?.group).toBe("pr-priority-triage-${{ github.event.pull_request.number }}")
    expect(triageParsed.concurrency?.["cancel-in-progress"]).toBe(true)
    expect(checkout?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")
    expect(checkout?.with).toEqual({
      "persist-credentials": false,
      ref: "${{ github.event.pull_request.base.sha }}",
    })
    expect(script?.uses).toBe("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3")
    expect(script?.env).toEqual({ PR_NUMBER: "${{ github.event.pull_request.number }}" })
    expect(script?.run).toBeUndefined()
    expect(triageWorkflow).toContain('event: "COMMENT"')
    expect(triageWorkflow).toContain("TRIAGE_MARKER")
    expect(triageWorkflow).toContain("github.rest.pulls.listFiles")
    expect(triageWorkflow).toContain("github.rest.issues.listLabelsOnIssue")
    expect(triageWorkflow).toContain("github.rest.issues.setLabels")
    expect(triageWorkflow).not.toContain("github.rest.issues.removeLabel")
    expect(triageWorkflow).not.toContain("github.rest.issues.addLabels")
    expect(triageWorkflow).toContain("planPriorityLabels")
    expect(triageWorkflow).toContain("github.rest.pulls.listReviews")
    expect(triageWorkflow).toContain("pathToFileURL")
    expect(triageWorkflow).toContain("process.env.GITHUB_WORKSPACE")
    expect(triageWorkflow).toContain("await import(")
    expect(triageWorkflow).not.toContain('require("./.github/scripts/pr-priority-triage.js")')
  })
})

describe("pr priority triage helper", () => {
  test("marks doc/workflow/test only changes as P3", () => {
    expect(classifyPriority([".github/workflows/officecli-bump.yml"]).priority).toBe("P3")
    expect(classifyPriority(["packages/app/e2e/session/session-composer-dock.spec.ts"]).priority).toBe("P3")
    expect(classifyPriority(["docs/release.md", "README.md"]).priority).toBe("P3")
  })

  test("marks user path changes as P2", () => {
    expect(
      classifyPriority([
        "packages/app/src/context/global-sync.tsx",
        "packages/app/src/context/global-sync/event-reducer.ts",
      ]),
    ).toEqual({
      priority: "P2",
      reason:
        "includes user-path files (packages/app/src/context/global-sync.tsx, packages/app/src/context/global-sync/event-reducer.ts)",
    })
    expect(classifyPriority(["packages/desktop-electron/src/main/index.ts"]).priority).toBe("P2")
  })

  test("defaults mixed non-low-risk changes to P2", () => {
    expect(classifyPriority(["packages/opencode/src/cli/cmd/github.ts"]).priority).toBe("P2")
  })

  test("builds one-shot review comments with marker and maintainer override", () => {
    const review = buildPriorityReview(["packages/app/e2e/session/session-composer-dock.spec.ts"])
    expect(review.priority).toBe("P3")
    expect(review.body).toContain(TRIAGE_MARKER)
    expect(review.body).toContain("Suggested priority: P3")
    expect(review.body).toContain("P1/P0 are reserved for maintainer confirmation")
  })

  test("plans priority labels without letting default P3 override mixed or manual priority", () => {
    expect(planPriorityLabels([".github/workflows/labeler.yml"], ["ci", "task"])).toEqual({
      suggestedPriority: "P3",
      desiredPriority: "P3",
      labels: ["ci", "task", "P3"],
      addLabels: ["P3"],
      removeLabels: [],
    })

    expect(
      planPriorityLabels([".github/workflows/labeler.yml", "packages/app/src/context/global-sync.tsx"], [
        "ci",
        "task",
        "app",
        "P3",
      ]),
    ).toEqual({
      suggestedPriority: "P2",
      desiredPriority: "P2",
      labels: ["ci", "task", "app", "P2"],
      addLabels: ["P2"],
      removeLabels: ["P3"],
    })

    expect(planPriorityLabels([".github/workflows/labeler.yml"], ["ci", "task", "P2", "P3"])).toEqual({
      suggestedPriority: "P3",
      desiredPriority: "P2",
      labels: ["ci", "task", "P2"],
      addLabels: [],
      removeLabels: ["P3"],
    })
  })

  test("matches recent PR sanity cases", () => {
    expect(
      classifyPriority([
        "packages/app/e2e/session/session-composer-dock.spec.ts",
        "packages/app/src/context/global-sdk.tsx",
        "packages/app/src/context/global-sdk/sse-cursor.test.ts",
        "packages/app/src/context/global-sdk/sse-cursor.ts",
        "packages/app/src/context/global-sync.tsx",
        "packages/app/src/context/global-sync/event-reducer.test.ts",
        "packages/app/src/context/global-sync/event-reducer.ts",
        "packages/app/src/testing/terminal.ts",
      ]).priority,
    ).toBe("P2")

    expect(classifyPriority(["packages/app/e2e/session/session-composer-dock.spec.ts"]).priority).toBe("P3")
    expect(
      classifyPriority([
        ".github/workflows/officecli-bump.yml",
        "packages/opencode/test/github/officecli-bump-workflow.test.ts",
      ]).priority,
    ).toBe("P3")
  })
})
