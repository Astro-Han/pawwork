import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { parseWorkflow, readWorkflow } from "./workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const ciWorkflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml")
const windowsAdvisoryWorkflowPath = path.join(repoRoot, ".github", "workflows", "windows-advisory.yml")
const turboJsonPath = path.join(repoRoot, "turbo.json")
const uiPackageJsonPath = path.join(repoRoot, "packages", "ui", "package.json")
const opencodeTestRoot = path.join(repoRoot, "packages", "opencode", "test")

const pinned = {
  checkout: "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
  pathsFilter: "dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d",
  setupNode: "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  setupBun: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  cache: "actions/cache@27d5ce7f107fe9357f9df03efb73ab90386fccae",
  junit: "mikepenz/action-junit-report@3a81627bfac62268172037048872e8ebd4207e6d",
  artifact: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
}

const runAttempt = "${{ github.run_attempt }}"
const githubSha = "${{ github.sha }}"
const lintJobName = "lint"
const frontendArchitectureJobName = "frontend-architecture"
const windowsUnitJobName = "unit-windows"

// Suffixes drive readable job and artifact names; commands use package.json names verbatim.
// `opencode` is intentionally unscoped because that is its actual package name.
const linuxUnitPackages = [
  {
    suffix: "ui",
    command: "bun turbo test:ci --filter=@opencode-ai/ui",
    reportPath: "packages/ui/.artifacts/unit/junit.xml",
  },
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
      "cd packages/opencode && bun test --timeout 30000 --reporter=junit --reporter-outfile=.artifacts/unit/junit-windows-session.xml test/session test/plugin test/permission test/util test/skill test/index-runtime-namespace.test.ts test/permission-agent.test.ts test/permission-cleanup.test.ts",
    reportPath: "packages/opencode/.artifacts/unit/junit-windows-session.xml",
  },
  {
    suffix: "opencode-config-project",
    usesTurbo: false,
    command:
      "cd packages/opencode && bun test --timeout 30000 --reporter=junit --reporter-outfile=.artifacts/unit/junit-windows-config-project.xml test/config test/project test/worktree test/file test/github test/settings test/settings.test.ts",
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
  artifactName: `unit-windows-${pkg.suffix}-${githubSha}-${runAttempt}`,
}))

function steps(job: string, workflowPath = ciWorkflowPath) {
  const parsed = parseWorkflow(workflowPath)
  return parsed.jobs?.[job]?.steps ?? []
}

function checkoutStep(job: string, workflowPath = ciWorkflowPath) {
  return steps(job, workflowPath).find((step) => step.uses?.startsWith("actions/checkout@"))
}

function stepByName(job: string, name: string, workflowPath = ciWorkflowPath) {
  return steps(job, workflowPath).find((step) => step.name === name)
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
  test("keeps packages/ui as a first-class Turbo CI test target", () => {
    const turbo = JSON.parse(readFileSync(turboJsonPath, "utf8")) as {
      tasks?: Record<string, { dependsOn?: string[]; outputs?: string[]; passThroughEnv?: string[] }>
    }
    const uiPackage = JSON.parse(readFileSync(uiPackageJsonPath, "utf8")) as {
      scripts?: Record<string, string>
    }

    expect(uiPackage.scripts?.["test:ci"]).toBe(
      "mkdir -p .artifacts/unit && bun test --reporter=junit --reporter-outfile=.artifacts/unit/junit.xml",
    )
    expect(turbo.tasks?.["@opencode-ai/ui#test:ci"]?.dependsOn).toEqual(["^build"])
    expect(turbo.tasks?.["@opencode-ai/ui#test:ci"]?.outputs).toEqual([".artifacts/unit/junit.xml"])
    expect(turbo.tasks?.["@opencode-ai/ui#test:ci"]?.passThroughEnv).toEqual(["*"])
  })

  test("pins third-party actions and disables checkout credential persistence", () => {
    const workflow = readWorkflow(ciWorkflowPath)
    const parsed = parseWorkflow(ciWorkflowPath)

    expect(parsed.name).toBe("ci")
    expect(parsed.permissions).toEqual({ contents: "read", "pull-requests": "read" })

    const linuxUnitJobNames = linuxUnitJobs.map((job) => job.jobName)

    for (const job of ["changes", "typecheck", lintJobName, ...linuxUnitJobNames]) {
      expect(checkoutStep(job)?.uses).toBe(pinned.checkout)
      expect(checkoutStep(job)?.with?.["persist-credentials"]).toBe(false)
    }

    expect(checkoutStep("changes")?.with?.["fetch-depth"]).toBe(0)

    for (const job of ["typecheck", ...linuxUnitJobNames]) {
      expect(steps(job).find((step) => step.uses?.startsWith("actions/setup-node@"))?.uses).toBe(pinned.setupNode)
      expect(steps(job).find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))?.uses).toBe(pinned.setupBun)
      expect(steps(job).filter((step) => step.uses?.startsWith("actions/cache@")).map((step) => step.uses)).toEqual([
        pinned.cache,
        pinned.cache,
      ])
    }

    expect(steps(lintJobName).find((step) => step.uses?.startsWith("actions/setup-node@"))?.uses).toBe(
      pinned.setupNode,
    )
    expect(steps(lintJobName).find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))?.uses).toBe(pinned.setupBun)
    expect(steps(lintJobName).filter((step) => step.uses?.startsWith("actions/cache@")).map((step) => step.uses)).toEqual(
      [pinned.cache],
    )

    for (const job of linuxUnitJobNames) {
      expect(stepByName(job, "Publish unit reports")?.uses).toBe(pinned.junit)
    }

    for (const job of linuxUnitJobNames) {
      expect(stepByName(job, "Upload unit artifacts")?.uses).toBe(pinned.artifact)
    }

    expect(workflow).not.toContain("pull_request_target")
    expect(workflow).not.toContain("persist-credentials: true")
    expect(parsed.jobs?.[windowsUnitJobName]).toBeUndefined()
  })

  test("keeps dev runs and cancels stale pull request runs", () => {
    const parsed = parseWorkflow(ciWorkflowPath)

    expect(parsed.concurrency?.group).toContain("github.ref == 'refs/heads/dev'")
    expect(parsed.concurrency?.group).toContain("github.run_id")
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe(true)
  })

  test("preserves the docs-only change detection contract with paths-filter", () => {
    const parsed = parseWorkflow(ciWorkflowPath)
    const changes = parsed.jobs?.changes
    const checkout = steps("changes").find((step) => step.uses?.startsWith("actions/checkout@"))
    const paths = steps("changes").find((step) => step.id === "paths")
    const filter = steps("changes").find((step) => step.id === "filter")

    expect(changes?.outputs?.docs_only).toBe("${{ steps.filter.outputs.docs_only }}")
    expect(checkout?.if).toBe("github.event_name == 'push'")
    expect(checkout?.with?.["fetch-depth"]).toBe(0)
    expect(paths?.uses).toBe(pinned.pathsFilter)
    expect(paths?.if).toBe("github.event_name == 'pull_request' || github.event_name == 'push'")
    expect(paths?.["continue-on-error"]).toBe(true)
    expect(paths?.with?.["predicate-quantifier"]).toBe("every")
    expect(paths?.with?.filters).toContain("code:")
    expect(paths?.with?.filters).toContain("'**'")
    expect(paths?.with?.filters).toContain("'!docs/**'")
    expect(paths?.with?.filters).toContain("'!packages/**/README.md'")
    expect(paths?.with?.filters).not.toContain("*.md")
    expect(filter?.if).toBe("always()")
    expect(filter?.env?.EVENT_NAME).toBe("${{ github.event_name }}")
    expect(filter?.env?.BEFORE_SHA).toBe("${{ github.event.before }}")
    expect(filter?.env?.PATHS_OUTCOME).toBe("${{ steps.paths.outcome }}")
    expect(filter?.env?.CODE_CHANGED).toBe("${{ steps.paths.outputs.code }}")
    expect(filter?.run).toContain('"$EVENT_NAME" != "pull_request"')
    expect(filter?.run).toContain('"$EVENT_NAME" != "push"')
    expect(filter?.run).toContain("docs_only=false")
    expect(filter?.run).toContain("PATHS_OUTCOME")
    expect(filter?.run).toContain("CODE_CHANGED")
    expect(filter?.run).toContain("echo \"docs_only=$docs_only\" >> \"$GITHUB_OUTPUT\"")
  })

  test("keeps lint as an advisory non-blocking product-code signal", () => {
    const parsed = parseWorkflow(ciWorkflowPath)
    const lint = parsed.jobs?.[lintJobName]
    const check = parsed.jobs?.check
    const checkNeeds = Array.isArray(check?.needs) ? check.needs : []

    expect(lint?.needs).toBe("changes")
    expect(lint?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(lint?.["runs-on"]).toBe("ubuntu-latest")
    expect(lint?.["timeout-minutes"]).toBe(20)
    expect(lint?.["continue-on-error"]).toBe(true)
    expect(lint?.permissions).toBeUndefined()
    expect(lint?.defaults?.run?.shell).toBeUndefined()
    expect(stepByName(lintJobName, "lint")?.run).toBe("bun run lint:ci")
    expect(checkNeeds).not.toContain(lintJobName)
  })

  test("runs frontend architecture inventory as a warn-only blocking infrastructure check", () => {
    const parsed = parseWorkflow(ciWorkflowPath)
    const job = parsed.jobs?.[frontendArchitectureJobName]
    const check = parsed.jobs?.check
    const checkNeeds = Array.isArray(check?.needs) ? check.needs : []
    const inventory = stepByName(frontendArchitectureJobName, "frontend inventory")
    const fetchBase = stepByName(frontendArchitectureJobName, "Fetch pull request base")
    const computeRange = stepByName(frontendArchitectureJobName, "Compute SHA range")
    const ratchet = stepByName(frontendArchitectureJobName, "LOC ratchet warnings")

    expect(job?.needs).toBe("changes")
    expect(job?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(job?.["runs-on"]).toBe("ubuntu-latest")
    expect(job?.["timeout-minutes"]).toBe(10)
    expect(job?.["continue-on-error"]).toBeUndefined()
    expect(job?.permissions).toBeUndefined()
    expect(checkoutStep(frontendArchitectureJobName)?.uses).toBe(pinned.checkout)
    expect(checkoutStep(frontendArchitectureJobName)?.with?.["fetch-depth"]).toBe(0)
    expect(fetchBase?.if).toBe("github.event_name == 'pull_request'")
    expect(fetchBase?.run).toContain("refs/remotes/origin/${{ github.event.pull_request.base.ref }}")
    expect(computeRange?.id).toBe("compute-range")
    expect(computeRange?.run).toContain("git merge-base")
    expect(computeRange?.run).toContain("BASE_SHA=")
    expect(computeRange?.run).toContain("HEAD_SHA=")
    expect(computeRange?.run).toContain("skipped=true")
    expect(steps(frontendArchitectureJobName).find((step) => step.uses?.startsWith("actions/setup-node@"))?.uses).toBe(
      pinned.setupNode,
    )
    expect(steps(frontendArchitectureJobName).find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))?.uses).toBe(
      pinned.setupBun,
    )
    expect(steps(frontendArchitectureJobName).filter((step) => step.uses?.startsWith("actions/cache@")).map((step) => step.uses)).toEqual([
      pinned.cache,
    ])
    expect(inventory?.run).toContain("node script/frontend-inventory.mjs --format json")
    expect(inventory?.run).toContain(".artifacts/frontend-architecture/frontend-inventory.json")
    expect(ratchet?.if).toBe("steps.compute-range.outputs.skipped != 'true'")
    expect(ratchet?.env).toBeUndefined()
    expect(ratchet?.run).toBe("node script/frontend-inventory.mjs --check-baseline --base \"$BASE_SHA\" --head \"$HEAD_SHA\"")
    expect(checkNeeds).toContain(frontendArchitectureJobName)
  })

  test("splits required Linux unit jobs by package while preserving Turbo dependency semantics", () => {
    const parsed = parseWorkflow(ciWorkflowPath)

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

  test("keeps Windows unit package and shard signals in the advisory workflow", () => {
    const workflow = readWorkflow(windowsAdvisoryWorkflowPath)
    const parsed = parseWorkflow(windowsAdvisoryWorkflowPath)
    const job = parsed.jobs?.[windowsUnitJobName]

    expect(parsed.name).toBe("windows-advisory")
    expect(workflow).toContain("run-name: windows advisory @ ${{ github.ref_name }} / ${{ github.sha }}")
    expect(workflow).toContain("push:")
    expect(workflow).toContain("branches: [dev]")
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).not.toContain("pull_request:")
    expect(parsed.concurrency?.group).toContain("github.ref == 'refs/heads/dev'")
    expect(parsed.concurrency?.group).toContain("github.run_id")
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe("${{ github.ref != 'refs/heads/dev' }}")
    expect(parsed.permissions).toEqual({ contents: "read" })
    expect(checkoutStep("changes", windowsAdvisoryWorkflowPath)?.uses).toBe(pinned.checkout)
    expect(checkoutStep("changes", windowsAdvisoryWorkflowPath)?.with?.["persist-credentials"]).toBe(false)
    expect(checkoutStep(windowsUnitJobName, windowsAdvisoryWorkflowPath)?.uses).toBe(pinned.checkout)
    expect(checkoutStep(windowsUnitJobName, windowsAdvisoryWorkflowPath)?.with?.["persist-credentials"]).toBe(false)
    expect(job?.name).toBe("unit-windows-${{ matrix.package }}")
    expect(job?.needs).toBe("changes")
    expect(job?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(job?.["runs-on"]).toBe("windows-latest")
    expect(job?.["timeout-minutes"]).toBe(20)
    expect(job?.["continue-on-error"]).toBeUndefined()
    expect(job?.strategy?.["fail-fast"]).toBe(false)
    expect(job?.permissions).toEqual({ contents: "read" })
    expect(job?.defaults?.run?.shell).toBe("bash")
    expect(steps(windowsUnitJobName, windowsAdvisoryWorkflowPath).find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    )?.uses).toBe(pinned.setupNode)
    expect(steps(windowsUnitJobName, windowsAdvisoryWorkflowPath).find((step) =>
      step.uses?.startsWith("oven-sh/setup-bun@"),
    )?.uses).toBe(pinned.setupBun)
    expect(
      steps(windowsUnitJobName, windowsAdvisoryWorkflowPath)
        .filter((step) => step.uses?.startsWith("actions/cache@"))
        .map((step) => step.uses),
    ).toEqual([pinned.cache, pinned.cache])
    expect(stepByName(windowsUnitJobName, "Prepare unit artifact directory", windowsAdvisoryWorkflowPath)?.run).toBe(
      'mkdir -p "$(dirname "${{ matrix.report_path }}")"',
    )
    expect(stepByName(windowsUnitJobName, "Prepare unit artifact directory", windowsAdvisoryWorkflowPath)?.if).toBe(
      "matrix.uses_turbo == false",
    )
    expect(stepByName(windowsUnitJobName, "unit", windowsAdvisoryWorkflowPath)?.id).toBe("unit")
    expect(stepByName(windowsUnitJobName, "unit", windowsAdvisoryWorkflowPath)?.["continue-on-error"]).toBeUndefined()
    expect(stepByName(windowsUnitJobName, "unit", windowsAdvisoryWorkflowPath)?.run).toContain("${{ matrix.command }}")
    expect(stepByName(windowsUnitJobName, "unit", windowsAdvisoryWorkflowPath)?.run).toContain(
      'echo "exit_code=$status" >> "$GITHUB_OUTPUT"',
    )
    expect(stepByName(windowsUnitJobName, "unit", windowsAdvisoryWorkflowPath)?.run).toContain(
      "### Windows unit diagnostic",
    )
    expect(stepByName(windowsUnitJobName, "unit", windowsAdvisoryWorkflowPath)?.run).toContain(
      "failed advisory signal",
    )
    expect(stepByName(windowsUnitJobName, "Publish unit reports", windowsAdvisoryWorkflowPath)).toBeUndefined()
    expect(stepByName(windowsUnitJobName, "Upload unit artifacts", windowsAdvisoryWorkflowPath)?.uses).toBe(
      pinned.artifact,
    )
    expect(stepByName(windowsUnitJobName, "Upload unit artifacts", windowsAdvisoryWorkflowPath)?.with?.name).toBe(
      "unit-windows-${{ matrix.package }}-${{ github.sha }}-${{ github.run_attempt }}",
    )
    expect(stepByName(windowsUnitJobName, "Upload unit artifacts", windowsAdvisoryWorkflowPath)?.with?.path).toBe(
      "${{ matrix.report_path }}",
    )

    const turboCacheStep = steps(windowsUnitJobName, windowsAdvisoryWorkflowPath).find(
      (step) => step.with?.path === ".turbo/cache",
    )
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
    const parsed = parseWorkflow(windowsAdvisoryWorkflowPath)
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
      expect(artifactName).toBe(`unit-windows-${jobName.replace("unit-windows-", "")}-${githubSha}-${runAttempt}`)
    }
  })

  test("covers each opencode test file exactly once across Windows opencode shards", () => {
    const parsed = parseWorkflow(windowsAdvisoryWorkflowPath)
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
    const parsed = parseWorkflow(ciWorkflowPath)
    const check = parsed.jobs?.check
    const needs = Array.isArray(check?.needs) ? check.needs : []
    const validate = stepByName("check", "Validate CI result")

    expect(check?.if).toBe("always()")
    expect(needs).toEqual([
      "changes",
      "typecheck",
      frontendArchitectureJobName,
      "unit-ui",
      "unit-app",
      "unit-opencode",
      "unit-desktop",
    ])
    expect(needs).not.toContain(lintJobName)
    expect(needs).not.toContain("unit-windows")
    expect(needs).not.toContain("unit-windows-app")
    expect(needs).not.toContain("unit-windows-desktop")
    expect(needs).not.toContain("unit-windows-opencode")
    expect(needs).not.toContain("unit-windows-opencode-session")
    expect(needs).not.toContain("unit-windows-opencode-config-project")
    expect(needs).not.toContain("unit-windows-opencode-server-tools")
    expect(validate?.env?.DOCS_ONLY).toBe("${{ needs.changes.outputs.docs_only }}")
    expect(validate?.env?.TYPECHECK_RESULT).toBe("${{ needs.typecheck.result }}")
    expect(validate?.env?.FRONTEND_ARCHITECTURE_RESULT).toBe("${{ needs['frontend-architecture'].result }}")
    expect(validate?.env?.UNIT_UI_RESULT).toBe("${{ needs['unit-ui'].result }}")
    expect(validate?.env?.UNIT_APP_RESULT).toBe("${{ needs['unit-app'].result }}")
    expect(validate?.env?.UNIT_OPENCODE_RESULT).toBe("${{ needs['unit-opencode'].result }}")
    expect(validate?.env?.UNIT_DESKTOP_RESULT).toBe("${{ needs['unit-desktop'].result }}")
    expect(validate?.run).toContain("Docs-only change, daily CI skipped.")
    expect(validate?.run).toContain("FRONTEND_ARCHITECTURE_RESULT")
    expect(validate?.run).toContain("UNIT_UI_RESULT")
    expect(validate?.run).toContain("UNIT_APP_RESULT")
    expect(validate?.run).toContain("UNIT_OPENCODE_RESULT")
    expect(validate?.run).toContain("UNIT_DESKTOP_RESULT")
  })
})
