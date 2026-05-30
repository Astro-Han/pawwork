import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseWorkflow, type Workflow } from "./workflow-parser"

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url))
const workflowsRoot = path.join(repoRoot, ".github", "workflows")
const expectedBunVersion = "1.3.14"
const auditComment = "Load-bearing for `bun audit` exit semantics"

function collectSetupBunPins(workflow: Workflow, relativePath: string) {
  const pins: string[] = []

  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const [stepIndex, step] of (job.steps ?? []).entries()) {
      if (!step.uses?.startsWith("oven-sh/setup-bun@")) continue

      const bunVersion = step.with?.["bun-version"] ?? "<missing>"
      pins.push(`${relativePath}:${jobName}:step-${stepIndex + 1}:bun-version: ${JSON.stringify(bunVersion)}`)
    }
  }

  return pins
}

describe("GitHub workflow Bun version pin", () => {
  test("detects setup-bun steps that omit bun-version", () => {
    const workflow: Workflow = {
      jobs: {
        unpinned: {
          steps: [{ uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6" }],
        },
      },
    }

    expect(collectSetupBunPins(workflow, "synthetic.yml")).toEqual([
      "synthetic.yml:unpinned:step-1:bun-version: \"<missing>\"",
    ])
  })

  test("keeps every setup-bun runtime on the audit-verified Bun version", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      packageManager?: string
    }
    expect(packageJson.packageManager).toBe(`bun@${expectedBunVersion}`)

    const workflowFiles = fs
      .readdirSync(workflowsRoot)
      .filter((name) => name.endsWith(".yml"))
      .sort()
      .map((name) => path.join(workflowsRoot, name))

    const setupBunPins: string[] = []
    const missingComments: string[] = []

    for (const workflowPath of workflowFiles) {
      const relativePath = path.relative(repoRoot, workflowPath)
      setupBunPins.push(...collectSetupBunPins(parseWorkflow(workflowPath), relativePath))

      const lines = fs.readFileSync(workflowPath, "utf8").split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        if (!line.includes("bun-version:")) continue

        const previousLines = lines.slice(Math.max(0, index - 3), index).join("\n")
        if (!previousLines.includes(auditComment)) {
          missingComments.push(`${relativePath}:${index + 1}`)
        }
      }
    }

    expect(setupBunPins).toEqual([
      ".github/workflows/build.yml:build-electron:step-5:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:typecheck:step-3:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:lint:step-3:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:frontend-architecture:step-5:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:unit-app:step-3:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:unit-ui:step-3:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:unit-opencode:step-3:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:unit-desktop:step-3:bun-version: \"1.3.14\"",
      ".github/workflows/deploy-site.yml:build-and-deploy:step-2:bun-version: \"1.3.14\"",
      ".github/workflows/desktop-smoke.yml:smoke-macos-arm64:step-3:bun-version: \"1.3.14\"",
      ".github/workflows/dev-dep-audit.yml:dev-dep-audit:step-3:bun-version: \"1.3.14\"",
      ".github/workflows/e2e-artifacts.yml:e2e-artifacts:step-3:bun-version: \"1.3.14\"",
      ".github/workflows/officecli-bump.yml:officecli-bump:step-3:bun-version: \"1.3.14\"",
      ".github/workflows/perf-probe-baseline.yml:perf-probe-baseline:step-7:bun-version: \"1.3.14\"",
      ".github/workflows/windows-advisory.yml:unit-windows:step-3:bun-version: \"1.3.14\"",
    ])
    expect(missingComments).toEqual([])
  })
})
