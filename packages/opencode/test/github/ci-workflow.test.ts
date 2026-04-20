import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parseWorkflow, readWorkflow } from "./workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml")

describe("ci workflow", () => {
  test("pins third-party actions and disables checkout credential persistence", () => {
    const workflow = readWorkflow(workflowPath)
    const parsed = parseWorkflow(workflowPath)
    const jobs = parsed.jobs ?? {}
    const changesSteps = jobs.changes?.steps ?? []
    const typecheckSteps = jobs.typecheck?.steps ?? []
    const unitSteps = jobs.unit?.steps ?? []
    const changesCheckoutStep = changesSteps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const typecheckCheckoutStep = typecheckSteps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const unitCheckoutStep = unitSteps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const typecheckBunStep = typecheckSteps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
    const unitBunStep = unitSteps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
    const junitStep = unitSteps.find((step) => step.name === "Publish unit reports")
    const uploadArtifactsStep = unitSteps.find((step) => step.name === "Upload unit artifacts")

    expect(parsed.name).toBe("ci")
    expect(parsed.permissions).toEqual({ contents: "read" })
    expect(changesCheckoutStep?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")
    expect(typecheckCheckoutStep?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")
    expect(unitCheckoutStep?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")

    expect(changesCheckoutStep?.with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    })

    expect(typecheckCheckoutStep?.with).toEqual({ "persist-credentials": false })
    expect(typecheckBunStep?.uses).toBe("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")

    expect(unitCheckoutStep?.with).toEqual({ "persist-credentials": false })
    expect(unitBunStep?.uses).toBe("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")
    expect(junitStep?.uses).toBe("mikepenz/action-junit-report@bccf2e31636835cf0874589931c4116687171386")
    expect(uploadArtifactsStep?.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")

    expect(workflow).not.toContain("pull_request_target")
    expect(workflow).not.toContain("persist-credentials: true")
  })
})
