import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parseWorkflow, readWorkflow } from "./workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml")

const pinned = {
  checkout: "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
  setupNode: "actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f",
  setupBun: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  cache: "actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae",
  junit: "mikepenz/action-junit-report@bccf2e31636835cf0874589931c4116687171386",
  artifact: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
}

function steps(job: string) {
  const parsed = parseWorkflow(workflowPath)
  return parsed.jobs?.[job]?.steps ?? []
}

function checkoutStep(job: string) {
  return steps(job).find((step) => step.uses?.startsWith("actions/checkout@"))
}

function stepByName(job: string, name: string) {
  return steps(job).find((step) => step.name === name)
}

describe("ci workflow", () => {
  test("pins third-party actions and disables checkout credential persistence", () => {
    const workflow = readWorkflow(workflowPath)
    const parsed = parseWorkflow(workflowPath)

    expect(parsed.name).toBe("ci")
    expect(parsed.permissions).toEqual({ contents: "read" })

    for (const job of ["changes", "typecheck", "unit-app", "unit-opencode", "unit-desktop", "unit-windows"]) {
      expect(checkoutStep(job)?.uses).toBe(pinned.checkout)
      expect(checkoutStep(job)?.with?.["persist-credentials"]).toBe(false)
    }

    expect(checkoutStep("changes")?.with?.["fetch-depth"]).toBe(0)

    for (const job of ["typecheck", "unit-app", "unit-opencode", "unit-desktop", "unit-windows"]) {
      expect(steps(job).find((step) => step.uses?.startsWith("actions/setup-node@"))?.uses).toBe(pinned.setupNode)
      expect(steps(job).find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))?.uses).toBe(pinned.setupBun)
      expect(steps(job).filter((step) => step.uses?.startsWith("actions/cache@")).map((step) => step.uses)).toEqual([
        pinned.cache,
        pinned.cache,
      ])
    }

    for (const job of ["unit-app", "unit-opencode", "unit-desktop", "unit-windows"]) {
      expect(stepByName(job, "Publish unit reports")?.uses).toBe(pinned.junit)
      expect(stepByName(job, "Upload unit artifacts")?.uses).toBe(pinned.artifact)
    }

    expect(workflow).not.toContain("pull_request_target")
    expect(workflow).not.toContain("persist-credentials: true")
  })

  test("keeps dev runs and cancels stale pull request runs", () => {
    const parsed = parseWorkflow(workflowPath)

    expect(parsed.concurrency?.group).toContain("github.ref == 'refs/heads/dev'")
    expect(parsed.concurrency?.group).toContain("github.run_id")
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe(true)
  })

  test("preserves the docs-only change detection contract", () => {
    const parsed = parseWorkflow(workflowPath)
    const changes = parsed.jobs?.changes
    const filter = steps("changes").find((step) => step.id === "filter")

    expect(changes?.outputs?.docs_only).toBe("${{ steps.filter.outputs.docs_only }}")
    expect(filter?.env?.EVENT_NAME).toBe("${{ github.event_name }}")
    expect(filter?.env?.BASE_SHA).toBe("${{ github.event.pull_request.base.sha || github.event.before }}")
    expect(filter?.env?.HEAD_SHA).toBe("${{ github.sha }}")
    expect(filter?.run).toContain("workflow_dispatch")
    expect(filter?.run).toContain("docs_only=false")
    expect(filter?.run).toContain("git diff --name-status --find-renames --find-copies")
    expect(filter?.run).toContain("R*|C*)")
    expect(filter?.run).toContain("if ! is_docs_path \"$path1\" || ! is_docs_path \"$path2\"; then")
    expect(filter?.run).toContain("echo \"docs_only=$docs_only\" >> \"$GITHUB_OUTPUT\"")
  })

  test("splits required Linux unit jobs by package while preserving Turbo dependency semantics", () => {
    const parsed = parseWorkflow(workflowPath)
    const linuxUnitJobs = [
      [
        "unit-app",
        "bun turbo test:ci --filter=@opencode-ai/app",
        "packages/app/.artifacts/unit/junit.xml",
        "unit results (app)",
        "unit-app-${{ github.run_attempt }}",
      ],
      [
        "unit-opencode",
        "bun turbo test:ci --filter=opencode",
        "packages/opencode/.artifacts/unit/junit.xml",
        "unit results (opencode)",
        "unit-opencode-${{ github.run_attempt }}",
      ],
      [
        "unit-desktop",
        "bun turbo test:ci --filter=@opencode-ai/desktop-electron",
        "packages/desktop-electron/.artifacts/unit/junit.xml",
        "unit results (desktop)",
        "unit-desktop-${{ github.run_attempt }}",
      ],
    ] as const

    for (const [jobName, command, reportPath, checkName, artifactName] of linuxUnitJobs) {
      const job = parsed.jobs?.[jobName]
      expect(job?.needs).toBe("changes")
      expect(job?.if).toBe("needs.changes.outputs.docs_only != 'true'")
      expect(job?.["runs-on"]).toBe("ubuntu-latest")
      expect(job?.["timeout-minutes"]).toBe(30)
      expect(job?.permissions).toEqual({ contents: "read", checks: "write" })
      expect(stepByName(jobName, "unit")?.run).toBe(command)
      expect(stepByName(jobName, "Publish unit reports")?.with?.report_paths).toBe(reportPath)
      expect(stepByName(jobName, "Publish unit reports")?.with?.check_name).toBe(checkName)
      expect(stepByName(jobName, "Upload unit artifacts")?.with?.name).toBe(artifactName)
      expect(stepByName(jobName, "Upload unit artifacts")?.with?.path).toBe(reportPath)
    }
  })

  test("keeps Windows unit as a non-blocking full-suite signal", () => {
    const parsed = parseWorkflow(workflowPath)
    const job = parsed.jobs?.["unit-windows"]

    expect(job?.["runs-on"]).toBe("windows-latest")
    expect(job?.["timeout-minutes"]).toBe(15)
    expect(job?.["continue-on-error"]).toBe(true)
    expect(job?.needs).toBe("changes")
    expect(job?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(stepByName("unit-windows", "unit")?.run).toBe("bun turbo test:ci")
    expect(stepByName("unit-windows", "Publish unit reports")?.with?.report_paths).toBe(
      "packages/**/.artifacts/unit/junit.xml",
    )
    expect(stepByName("unit-windows", "Publish unit reports")?.with?.check_name).toBe("unit results (windows)")
    expect(stepByName("unit-windows", "Upload unit artifacts")?.with?.name).toBe(
      "unit-windows-${{ github.run_attempt }}",
    )
    expect(stepByName("unit-windows", "Upload unit artifacts")?.with?.path).toBe(
      "packages/**/.artifacts/unit/junit.xml",
    )
  })

  test("keeps docs-only behavior and excludes Windows from the blocking aggregate", () => {
    const parsed = parseWorkflow(workflowPath)
    const check = parsed.jobs?.check
    const needs = Array.isArray(check?.needs) ? check.needs : []
    const validate = stepByName("check", "Validate CI result")

    expect(check?.if).toBe("always()")
    expect(needs).toEqual(["changes", "typecheck", "unit-app", "unit-opencode", "unit-desktop"])
    expect(needs).not.toContain("unit-windows")
    expect(validate?.env?.DOCS_ONLY).toBe("${{ needs.changes.outputs.docs_only }}")
    expect(validate?.env?.TYPECHECK_RESULT).toBe("${{ needs.typecheck.result }}")
    expect(validate?.env?.UNIT_APP_RESULT).toBe("${{ needs['unit-app'].result }}")
    expect(validate?.env?.UNIT_OPENCODE_RESULT).toBe("${{ needs['unit-opencode'].result }}")
    expect(validate?.env?.UNIT_DESKTOP_RESULT).toBe("${{ needs['unit-desktop'].result }}")
    expect(validate?.run).toContain("Docs-only change, daily CI skipped.")
    expect(validate?.run).toContain("UNIT_APP_RESULT")
    expect(validate?.run).toContain("UNIT_OPENCODE_RESULT")
    expect(validate?.run).toContain("UNIT_DESKTOP_RESULT")
  })
})
