import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { parseWorkflow, readWorkflow } from "./workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml")
const opencodeTestRoot = path.join(repoRoot, "packages", "opencode", "test")

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
const linuxUnitPackages = [
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

const windowsOpencodeShards = [
  // Intentional dual source with ci.yml: this pins the exact shard command
  // contract while the coverage test expands these paths to catch workflow
  // drift and missing opencode tests. Update ci.yml and this list together.
  {
    suffix: "opencode-session",
    usesTurbo: false,
    command:
      "cd packages/opencode && bun test --timeout 30000 --reporter=junit --reporter-outfile=.artifacts/unit/junit-windows-session.xml test/session test/plugin test/permission test/util test/skill test/index-runtime-namespace.test.ts test/npm.test.ts test/permission-task.test.ts",
    reportPath: "packages/opencode/.artifacts/unit/junit-windows-session.xml",
  },
  {
    suffix: "opencode-config-project",
    usesTurbo: false,
    command:
      "cd packages/opencode && bun test --timeout 30000 --reporter=junit --reporter-outfile=.artifacts/unit/junit-windows-config-project.xml test/config test/project test/file test/github test/settings.test.ts",
    reportPath: "packages/opencode/.artifacts/unit/junit-windows-config-project.xml",
  },
  {
    suffix: "opencode-server-tools",
    usesTurbo: false,
    command:
      "cd packages/opencode && bun test --timeout 30000 --reporter=junit --reporter-outfile=.artifacts/unit/junit-windows-server-tools.xml test/server test/snapshot test/tool test/mcp test/question test/effect test/agent test/git test/storage test/provider test/pty test/share test/script test/memory test/lsp test/fixture test/acp test/bus test/cli test/global test/format test/account test/sync test/filesystem test/patch test/shell test/control-plane test/ide test/installation test/auth",
    reportPath: "packages/opencode/.artifacts/unit/junit-windows-server-tools.xml",
  },
] as const

const windowsUnitPackages = [
  {
    suffix: "app",
    usesTurbo: true,
    command: "bun turbo test:ci --filter=@opencode-ai/app",
    reportPath: "packages/app/.artifacts/unit/junit.xml",
  },
  ...windowsOpencodeShards,
  {
    suffix: "desktop",
    usesTurbo: true,
    command: "bun turbo test:ci --filter=@opencode-ai/desktop-electron",
    reportPath: "packages/desktop-electron/.artifacts/unit/junit.xml",
  },
] as const

const linuxUnitJobs = linuxUnitPackages.map((pkg) => ({
  ...pkg,
  jobName: `unit-${pkg.suffix}`,
  checkName: `unit results (${pkg.suffix})`,
  artifactName: `unit-${pkg.suffix}-${runAttempt}`,
}))

const windowsUnitJobs = windowsUnitPackages.map((pkg) => ({
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

function toPosix(relativePath: string) {
  return relativePath.split(path.sep).join("/")
}

function isTestFile(filePath: string) {
  return /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/.test(filePath)
}

function listOpencodeTestFiles(dir = opencodeTestRoot): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return listOpencodeTestFiles(fullPath)
    if (!entry.isFile() || !isTestFile(entry.name)) return []

    return [`test/${toPosix(path.relative(opencodeTestRoot, fullPath))}`]
  })
}

function expandOpencodeTestPath(testPath: string): string[] {
  const fullPath = path.join(repoRoot, "packages", "opencode", testPath)
  if (!existsSync(fullPath)) {
    throw new Error(`Windows opencode shard path does not exist: ${testPath}`)
  }
  if (statSync(fullPath).isDirectory()) {
    return listOpencodeTestFiles(fullPath)
  }
  return [testPath]
}

function testPathArgs(command: string) {
  const testArgs = command.split(" bun test ")[1]
  if (!testArgs) {
    throw new Error(`Windows opencode shard command does not invoke bun test: ${command}`)
  }
  return testArgs.split(/\s+/).filter((arg) => arg.startsWith("test/"))
}

function isWindowsOpencodeShard(item: Record<string, unknown>): item is { command: string; package: string } {
  return item.uses_turbo === false && typeof item.package === "string" && typeof item.command === "string"
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

  test("keeps Windows unit package and shard signals advisory", () => {
    const parsed = parseWorkflow(workflowPath)
    const job = parsed.jobs?.[windowsUnitJobName]

    expect(job?.name).toBe("unit-windows-${{ matrix.package }}")
    expect(job?.needs).toBe("changes")
    expect(job?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(job?.["runs-on"]).toBe("windows-latest")
    expect(job?.["timeout-minutes"]).toBe(20)
    expect(job?.["continue-on-error"]).toBe(true)
    expect(job?.strategy?.["fail-fast"]).toBe(false)
    expect(job?.permissions).toEqual({ contents: "read" })
    expect(job?.defaults?.run?.shell).toBe("bash")
    expect(stepByName(windowsUnitJobName, "Prepare unit artifact directory")?.run).toBe(
      'mkdir -p "$(dirname "${{ matrix.report_path }}")"',
    )
    expect(stepByName(windowsUnitJobName, "Prepare unit artifact directory")?.if).toBe("matrix.uses_turbo == false")
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

    const turboCacheStep = steps(windowsUnitJobName).find((step) => step.with?.path === ".turbo/cache")
    expect(turboCacheStep?.if).toBe("matrix.uses_turbo")
    expect(turboCacheStep?.with?.key).toBe(
      "turbo-${{ runner.os }}-unit-windows-${{ matrix.package }}-${{ hashFiles('turbo.json', '**/package.json', 'bun.lock') }}-${{ github.sha }}",
    )
    expect(turboCacheStep?.with?.["restore-keys"]).toBe(
      "turbo-${{ runner.os }}-unit-windows-${{ matrix.package }}-${{ hashFiles('turbo.json', '**/package.json', 'bun.lock') }}-\n" +
        "turbo-${{ runner.os }}-unit-windows-${{ matrix.package }}-\n",
    )
  })

  test("defines Windows unit packages and opencode shards", () => {
    const parsed = parseWorkflow(workflowPath)
    const job = parsed.jobs?.[windowsUnitJobName]
    const matrixIncludes = job?.strategy?.matrix?.include ?? []

    expect(matrixIncludes).toEqual(
      windowsUnitJobs.map(({ jobName, usesTurbo, command, reportPath }) => ({
        package: jobName.replace("unit-windows-", ""),
        uses_turbo: usesTurbo,
        command,
        report_path: reportPath,
      })),
    )

    for (const { jobName, artifactName } of windowsUnitJobs) {
      expect(parsed.jobs?.[jobName]).toBeUndefined()
      expect(artifactName).toBe(`unit-windows-${jobName.replace("unit-windows-", "")}-${runAttempt}`)
    }
  })

  test("covers each opencode test file exactly once across Windows opencode shards", () => {
    const parsed = parseWorkflow(workflowPath)
    const matrixIncludes = parsed.jobs?.[windowsUnitJobName]?.strategy?.matrix?.include ?? []
    const opencodeShards = matrixIncludes.filter(isWindowsOpencodeShard)
    const allTestFiles = listOpencodeTestFiles().sort()
    const allTestFilesSet = new Set(allTestFiles)
    const coverage = new Map<string, string[]>()
    const extra: string[] = []
    const shardFileCounts = new Map<string, number>()

    // This repeats names instead of deriving from windowsOpencodeShards so the
    // coverage test pins the public advisory check names explicitly.
    expect(opencodeShards.map((item) => item.package)).toEqual([
      "opencode-session",
      "opencode-config-project",
      "opencode-server-tools",
    ])

    for (const item of opencodeShards) {
      const testPaths = testPathArgs(item.command)
      let fileCount = 0
      for (const testPath of testPaths) {
        const expanded = expandOpencodeTestPath(testPath)
        fileCount += expanded.length
        for (const file of expanded) {
          if (!allTestFilesSet.has(file)) {
            extra.push(file)
            continue
          }
          coverage.set(file, [...(coverage.get(file) ?? []), item.package])
        }
      }
      shardFileCounts.set(item.package, fileCount)
    }

    const missing = allTestFiles.filter((file) => !coverage.has(file))
    const duplicates = [...coverage.entries()]
      .filter(([, shardNames]) => shardNames.length > 1)
      .map(([file, shardNames]) => ({ file, shards: shardNames }))

    if (missing.length > 0 || extra.length > 0 || duplicates.length > 0) {
      const shardNames = opencodeShards.map((item) => item.package)
      const smallestShard = [...shardFileCounts.entries()].sort(([, left], [, right]) => left - right)[0]?.[0]
      const details = [
        "Windows opencode shard coverage drift.",
        missing.length > 0 ? `Uncovered files: ${missing.join(", ")}` : undefined,
        extra.length > 0 ? `Unknown shard paths: ${extra.sort().join(", ")}` : undefined,
        duplicates.length > 0 ? `Duplicate coverage: ${JSON.stringify(duplicates)}` : undefined,
        `Shard choices: ${shardNames.join(" | ")}`,
        smallestShard ? `Suggested starting shard for uncovered files: ${smallestShard}` : undefined,
      ].filter((line): line is string => typeof line === "string")

      throw new Error(details.join("\n"))
    }

    expect({ duplicates, extra: extra.sort(), missing }).toEqual({
      duplicates: [],
      extra: [],
      missing: [],
    })
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
    expect(needs).not.toContain("unit-windows-opencode-session")
    expect(needs).not.toContain("unit-windows-opencode-config-project")
    expect(needs).not.toContain("unit-windows-opencode-server-tools")
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
