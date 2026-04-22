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

const runAttempt = "${{ github.run_attempt }}"
const windowsUnitJobName = "unit-windows"

// Suffixes drive readable job and artifact names; commands use package.json names verbatim.
// `opencode` is intentionally unscoped because that is its actual package name.
const unitPackages = [
  {
    suffix: "app",
    command: "bun turbo test:ci --filter=@opencode-ai/app",
    reportPath: "packages/app/.artifacts/unit/junit.xml",
  },
  {
    suffix: "opencode",
    command: "bun turbo test:ci --filter=opencode",
    reportPath: "packages/opencode/.artifacts/unit/junit.xml",
  },
  {
    suffix: "desktop",
    command: "bun turbo test:ci --filter=@opencode-ai/desktop-electron",
    reportPath: "packages/desktop-electron/.artifacts/unit/junit.xml",
  },
] as const

const linuxUnitJobs = unitPackages.map((pkg) => ({
  ...pkg,
  jobName: `unit-${pkg.suffix}`,
  checkName: `unit results (${pkg.suffix})`,
  artifactName: `unit-${pkg.suffix}-${runAttempt}`,
}))

const windowsUnitJobs = unitPackages.map((pkg) => ({
  ...pkg,
  jobName: `unit-windows-${pkg.suffix}`,
  artifactName: `unit-windows-${pkg.suffix}-${runAttempt}`,
}))

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

    const linuxUnitJobNames = linuxUnitJobs.map((job) => job.jobName)
    const setupUnitJobNames = [...linuxUnitJobNames, windowsUnitJobName]

    for (const job of ["changes", "typecheck", ...setupUnitJobNames]) {
      expect(checkoutStep(job)?.uses).toBe(pinned.checkout)
      expect(checkoutStep(job)?.with?.["persist-credentials"]).toBe(false)
    }

    expect(checkoutStep("changes")?.with?.["fetch-depth"]).toBe(0)

    for (const job of ["typecheck", ...setupUnitJobNames]) {
      expect(steps(job).find((step) => step.uses?.startsWith("actions/setup-node@"))?.uses).toBe(pinned.setupNode)
      expect(steps(job).find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))?.uses).toBe(pinned.setupBun)
      expect(steps(job).filter((step) => step.uses?.startsWith("actions/cache@")).map((step) => step.uses)).toEqual([
        pinned.cache,
        pinned.cache,
      ])
    }

    for (const job of linuxUnitJobNames) {
      expect(stepByName(job, "Publish unit reports")?.uses).toBe(pinned.junit)
    }

    expect(stepByName(windowsUnitJobName, "Publish unit reports")).toBeUndefined()

    for (const job of [...linuxUnitJobNames, windowsUnitJobName]) {
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

    for (const { jobName, command, reportPath, checkName, artifactName } of linuxUnitJobs) {
      const job = parsed.jobs?.[jobName]
      expect(job?.needs).toBe("changes")
      expect(job?.if).toBe("needs.changes.outputs.docs_only != 'true'")
      expect(job?.["runs-on"]).toBe("ubuntu-latest")
      expect(job?.["timeout-minutes"]).toBe(30)
      expect(job?.permissions).toEqual({ contents: "read", checks: "write" })
      expect(job?.defaults?.run?.shell).toBeUndefined()
      expect(stepByName(jobName, "unit")?.run).toBe(command)
      expect(stepByName(jobName, "Publish unit reports")?.with?.report_paths).toBe(reportPath)
      expect(stepByName(jobName, "Publish unit reports")?.with?.check_name).toBe(checkName)
      expect(stepByName(jobName, "Upload unit artifacts")?.with?.name).toBe(artifactName)
      expect(stepByName(jobName, "Upload unit artifacts")?.with?.path).toBe(reportPath)
    }
  })

  test("splits Windows unit signals by package without publishing advisory check runs", () => {
    const parsed = parseWorkflow(workflowPath)
    const job = parsed.jobs?.[windowsUnitJobName]
    const matrixIncludes = job?.strategy?.matrix?.include ?? []

    expect(job?.name).toBe("unit-windows-${{ matrix.package }}")
    expect(job?.needs).toBe("changes")
    expect(job?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(job?.["runs-on"]).toBe("windows-latest")
    expect(job?.["timeout-minutes"]).toBe(20)
    expect(job?.["continue-on-error"]).toBe(true)
    expect(job?.strategy?.["fail-fast"]).toBe(false)
    expect(job?.permissions).toEqual({ contents: "read" })
    expect(job?.defaults?.run?.shell).toBe("bash")
    expect(stepByName(windowsUnitJobName, "unit")?.id).toBe("unit")
    expect(stepByName(windowsUnitJobName, "unit")?.["continue-on-error"]).toBe(true)
    expect(stepByName(windowsUnitJobName, "unit")?.run).toContain("${{ matrix.command }}")
    expect(stepByName(windowsUnitJobName, "unit")?.run).toContain('echo "exit_code=$status" >> "$GITHUB_OUTPUT"')
    expect(stepByName(windowsUnitJobName, "unit")?.run).toContain("### Windows unit diagnostic")
    expect(stepByName(windowsUnitJobName, "unit")?.run).toContain("failed advisory signal")
    expect(stepByName(windowsUnitJobName, "Publish unit reports")).toBeUndefined()
    expect(stepByName(windowsUnitJobName, "Upload unit artifacts")?.uses).toBe(pinned.artifact)
    expect(stepByName(windowsUnitJobName, "Upload unit artifacts")?.with?.name).toBe(
      "unit-windows-${{ matrix.package }}-${{ github.run_attempt }}",
    )
    expect(stepByName(windowsUnitJobName, "Upload unit artifacts")?.with?.path).toBe("${{ matrix.report_path }}")

    const turboCacheStep = steps(windowsUnitJobName).filter((step) => step.uses?.startsWith("actions/cache@"))[1]
    expect(turboCacheStep?.with?.key).toBe(
      "turbo-${{ runner.os }}-unit-windows-${{ matrix.package }}-${{ hashFiles('turbo.json', '**/package.json', 'bun.lock') }}-${{ github.sha }}",
    )
    expect(turboCacheStep?.with?.["restore-keys"]).toBe(
      "turbo-${{ runner.os }}-unit-windows-${{ matrix.package }}-${{ hashFiles('turbo.json', '**/package.json', 'bun.lock') }}-\n" +
        "turbo-${{ runner.os }}-unit-windows-${{ matrix.package }}-\n",
    )

    expect(matrixIncludes).toEqual(
      windowsUnitJobs.map(({ jobName, command, reportPath }) => ({
        package: jobName.replace("unit-windows-", ""),
        command,
        report_path: reportPath,
      })),
    )

    for (const { jobName, command, reportPath, artifactName } of windowsUnitJobs) {
      expect(parsed.jobs?.[jobName]).toBeUndefined()
      expect(artifactName).toBe(`unit-windows-${jobName.replace("unit-windows-", "")}-${runAttempt}`)
    }
  })

  test("keeps docs-only behavior and excludes Windows from the blocking aggregate", () => {
    const parsed = parseWorkflow(workflowPath)
    const check = parsed.jobs?.check
    const needs = Array.isArray(check?.needs) ? check.needs : []
    const validate = stepByName("check", "Validate CI result")

    expect(check?.if).toBe("always()")
    expect(needs).toEqual(["changes", "typecheck", "unit-app", "unit-opencode", "unit-desktop"])
    expect(needs).not.toContain("unit-windows")
    expect(needs).not.toContain("unit-windows-app")
    expect(needs).not.toContain("unit-windows-desktop")
    expect(needs).not.toContain("unit-windows-opencode")
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
