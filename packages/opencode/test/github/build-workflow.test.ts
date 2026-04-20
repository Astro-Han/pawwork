import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parseWorkflow, readWorkflow } from "./workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "build.yml")

describe("build workflow", () => {
  test("pins upgraded checkout and upload-artifact refs in the release workflow", () => {
    const workflow = readWorkflow(workflowPath)
    const parsed = parseWorkflow(workflowPath)
    const buildElectron = parsed.jobs?.["build-electron"]
    const steps = buildElectron?.steps ?? []
    const checkoutSteps = steps.filter(
      (step) => step.uses === "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
    )
    const setupNodeStep = steps.find(
      (step) => step.uses === "actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f",
    )
    const uploadArtifactSteps = steps.filter(
      (step) => step.uses === "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    )
    const signedArtifactStep = steps.find((step) => step.name === "Upload signed app artifact")

    expect(parsed.name).toBe("build")
    expect(parsed.permissions).toEqual({
      actions: "read",
      contents: "write",
    })
    expect(parsed.on?.workflow_dispatch).toBeDefined()
    expect(buildElectron?.["runs-on"]).toBe("${{ matrix.host }}")
    expect(checkoutSteps).toHaveLength(2)
    expect(checkoutSteps[0]?.with).toEqual({ "persist-credentials": false })
    expect(checkoutSteps[1]?.with).toEqual({
      "persist-credentials": false,
      ref: "${{ inputs.source_sha }}",
    })
    expect(setupNodeStep?.with).toEqual({ "node-version": "24" })
    expect(uploadArtifactSteps).toHaveLength(2)
    expect(signedArtifactStep?.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")

    expect(workflow).not.toContain("persist-credentials: true")
    expect(workflow).not.toContain("pull_request_target")
  })
})
