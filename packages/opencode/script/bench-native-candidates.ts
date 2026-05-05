#!/usr/bin/env bun

import { Buffer } from "node:buffer"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import fuzzysort from "fuzzysort"
import { Patch } from "../src/patch"
import { Process } from "../src/util/process"

type BenchConfig = {
  cwd: string
  label: string
  iterations: number
  warmups: number
  showPath: boolean
  scenario?: string
}

type CommandResult = {
  code: number
  stdout: Buffer
  stderr: Buffer
  spawnCount: number
}

type RunMetrics = {
  durationMs: number
  spawnCount?: number
  resultCount?: number
  outputBytes?: number
  notes?: string
}

type ScenarioRun =
  | { status: "ok"; metrics: RunMetrics }
  | { status: "skipped"; notes: string }
  | { status: "error"; error: string }

type Scenario = {
  name: string
  group: "file" | "git" | "patch" | "process"
  run: () => Promise<Omit<RunMetrics, "durationMs">>
}

type BenchResult = {
  name: string
  group: Scenario["group"]
  status: "ok" | "skipped" | "error"
  firstRunMs?: number
  repeatP50Ms?: number
  repeatP95Ms?: number
  spawnCount?: number
  resultCount?: number
  outputBytes?: number
  notes?: string
}

type RepoSummary = {
  fileCount?: number
  dirCount?: number
  gitStatus: "clean" | "dirty" | "unknown"
}

type Environment = {
  os: string
  cpu: string
  bun: string
  node: string
  git: string
  repo: string
  path: string
  files: string
  dirs: string
  gitStatus: RepoSummary["gitStatus"]
}

class SkipScenario extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SkipScenario"
  }
}

const gitConfig = [
  "--no-optional-locks",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.symlinks=true",
  "-c",
  "core.quotepath=false",
] as const

const rgFilesArgs = ["--no-config", "--files", "--hidden", "--glob=!.git/*", "."] as const

const scenarioQueries = ["session", "worktree", "git", "index", "config"] as const

const usage = `Usage:
  bun --cwd packages/opencode ./script/bench-native-candidates.ts --cwd /path/to/repo [options]

Options:
  --cwd <path>           Required repo or workspace path to benchmark
  --label <name>         Output repo label, defaults to basename(cwd)
  --iterations <n>       Measured repeat runs, defaults to 7
  --warmups <n>          Warmup runs before repeat measurements, defaults to 2
  --show-path            Print the full cwd path instead of redacting it
  --scenario <name>      Run one scenario by exact or slug name
  --help                 Print this help
`

function parseArgs(argv: string[]): BenchConfig {
  const args = [...argv]
  const config: Partial<BenchConfig> = {
    iterations: 7,
    warmups: 2,
    showPath: false,
  }

  while (args.length > 0) {
    const arg = args.shift()!
    switch (arg) {
      case "--help":
        console.log(usage)
        process.exit(0)
      case "--cwd":
        config.cwd = requiredValue(arg, args)
        break
      case "--label":
        config.label = requiredValue(arg, args)
        break
      case "--iterations":
        config.iterations = parsePositiveInteger(arg, requiredValue(arg, args))
        break
      case "--warmups":
        config.warmups = parseNonNegativeInteger(arg, requiredValue(arg, args))
        break
      case "--show-path":
        config.showPath = true
        break
      case "--scenario":
        config.scenario = requiredValue(arg, args)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!config.cwd) throw new Error("--cwd is required")
  const cwd = path.resolve(config.cwd)
  return {
    cwd,
    label: config.label ?? path.basename(cwd),
    iterations: config.iterations ?? 7,
    warmups: config.warmups ?? 2,
    showPath: config.showPath ?? false,
    scenario: config.scenario,
  }
}

function requiredValue(flag: string, args: string[]) {
  const value = args.shift()
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

function parsePositiveInteger(flag: string, value: string) {
  const n = Number.parseInt(value, 10)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`)
  return n
}

function parseNonNegativeInteger(flag: string, value: string) {
  const n = Number.parseInt(value, 10)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`)
  return n
}

async function runCommand(cmd: string[], cwd: string): Promise<CommandResult> {
  if (cmd.length === 0) throw new Error("Command is required")
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
    ])
    return {
      code,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr),
      spawnCount: 1,
    }
  } catch (error) {
    throw new Error(sanitizeError(error, cwd))
  }
}

async function runGit(args: string[], cwd: string) {
  return runCommand(["git", ...gitConfig, ...args], cwd)
}

async function runGitMaybe(args: string[], cwd: string) {
  try {
    return await runGit(args, cwd)
  } catch {
    return undefined
  }
}

async function runRgFiles(cwd: string) {
  const result = await runCommand(["rg", ...rgFilesArgs], cwd)
  if (result.code !== 0) {
    throw new SkipScenario("rg --files is unavailable or failed")
  }
  return {
    ...result,
    files: splitLines(result.stdout.toString("utf8")),
  }
}

function splitLines(text: string) {
  return text.split(/\r?\n/).filter(Boolean)
}

function splitNul(text: string) {
  return text.split("\0").filter(Boolean)
}

function dirListFromFiles(files: string[]) {
  const dirs = new Set<string>()
  for (const file of files) {
    const parts = file.split(/[\\/]/).filter(Boolean)
    for (let i = 1; i < parts.length; i++) {
      dirs.add(`${parts.slice(0, i).join("/")}/`)
    }
  }
  return Array.from(dirs).sort()
}

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function scenarioMatches(filter: string | undefined, scenario: Scenario) {
  if (!filter || filter === "all") return true
  const wanted = slug(filter)
  return slug(scenario.name) === wanted || slug(`${scenario.group} ${scenario.name}`) === wanted
}

async function timed(run: () => Promise<Omit<RunMetrics, "durationMs">>): Promise<ScenarioRun> {
  const start = performance.now()
  try {
    const metrics = await run()
    return {
      status: "ok",
      metrics: {
        ...metrics,
        durationMs: performance.now() - start,
      },
    }
  } catch (error) {
    if (error instanceof SkipScenario) return { status: "skipped", notes: error.message }
    return { status: "error", error: sanitizeError(error) }
  }
}

async function benchScenario(scenario: Scenario, config: BenchConfig): Promise<BenchResult> {
  const first = await timed(scenario.run)
  if (first.status === "skipped") {
    return {
      name: scenario.name,
      group: scenario.group,
      status: "skipped",
      notes: first.notes,
    }
  }
  if (first.status === "error") {
    return {
      name: scenario.name,
      group: scenario.group,
      status: "error",
      notes: first.error,
    }
  }

  for (let i = 0; i < config.warmups; i++) {
    const warmup = await timed(scenario.run)
    if (warmup.status === "error") {
      return {
        name: scenario.name,
        group: scenario.group,
        status: "error",
        notes: `warmup failed: ${warmup.error}`,
      }
    }
  }

  const measured: RunMetrics[] = []
  for (let i = 0; i < config.iterations; i++) {
    const run = await timed(scenario.run)
    if (run.status === "skipped") {
      return {
        name: scenario.name,
        group: scenario.group,
        status: "skipped",
        notes: run.notes,
      }
    }
    if (run.status === "error") {
      return {
        name: scenario.name,
        group: scenario.group,
        status: "error",
        notes: run.error,
      }
    }
    measured.push(run.metrics)
  }

  return {
    name: scenario.name,
    group: scenario.group,
    status: "ok",
    firstRunMs: first.metrics.durationMs,
    repeatP50Ms: percentile(
      measured.map((run) => run.durationMs),
      0.5,
    ),
    repeatP95Ms: percentile(
      measured.map((run) => run.durationMs),
      0.95,
    ),
    spawnCount: first.metrics.spawnCount,
    resultCount: first.metrics.resultCount,
    outputBytes: first.metrics.outputBytes,
    notes: first.metrics.notes,
  }
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.ceil(sorted.length * p) - 1)
  return sorted[idx]
}

function makeSyntheticPatch(hunks: number) {
  const lines = ["*** Begin Patch", "*** Update File: synthetic.txt"]
  for (let i = 0; i < hunks; i++) {
    const line = String(i + 1).padStart(6, "0")
    lines.push(`@@ line ${line}`)
    lines.push(` line ${line}`)
    lines.push(`-old value ${line}`)
    lines.push(`+new value ${line}`)
    lines.push(` next line ${line}`)
  }
  lines.push("*** End Patch")
  return lines.join("\n")
}

function parseStatusCount(stdout: Buffer) {
  return splitNul(stdout.toString("utf8")).filter((item) => item.slice(3)).length
}

function parseNameStatusCount(stdout: Buffer) {
  const parts = splitNul(stdout.toString("utf8"))
  let count = 0
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] && parts[i + 1]) count++
  }
  return count
}

function parseNumstat(stdout: Buffer) {
  let files = 0
  let additions = 0
  let deletions = 0
  for (const item of splitNul(stdout.toString("utf8"))) {
    const first = item.indexOf("\t")
    const second = item.indexOf("\t", first + 1)
    if (first === -1 || second === -1) continue
    const adds = item.slice(0, first)
    const dels = item.slice(first + 1, second)
    files++
    additions += adds === "-" ? 0 : Number.parseInt(adds || "0", 10) || 0
    deletions += dels === "-" ? 0 : Number.parseInt(dels || "0", 10) || 0
  }
  return { files, additions, deletions }
}

function parseWorktreeCount(stdout: Buffer) {
  return splitLines(stdout.toString("utf8")).filter((line) => line.startsWith("worktree ")).length
}

async function collectFileSummary(cwd: string) {
  try {
    const rg = await runRgFiles(cwd)
    const dirs = dirListFromFiles(rg.files)
    return {
      files: rg.files,
      dirs,
      fileCount: rg.files.length,
      dirCount: dirs.length,
    }
  } catch {
    return {
      files: [] as string[],
      dirs: [] as string[],
      fileCount: undefined,
      dirCount: undefined,
    }
  }
}

async function collectRepoSummary(cwd: string, fileCount?: number, dirCount?: number): Promise<RepoSummary> {
  const status = await runGitMaybe(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], cwd)
  return {
    fileCount,
    dirCount,
    gitStatus: status && status.code === 0 ? (parseStatusCount(status.stdout) === 0 ? "clean" : "dirty") : "unknown",
  }
}

async function collectEnvironment(config: BenchConfig, summary: RepoSummary): Promise<Environment> {
  const gitVersion = await runCommand(["git", "--version"], config.cwd)
    .then((result) => (result.code === 0 ? result.stdout.toString("utf8").trim() : "unknown"))
    .catch(() => "unknown")
  const cpu = os.cpus()[0]
  return {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: cpu ? `${cpu.model}, ${os.cpus().length} cores` : "unknown",
    bun: Bun.version,
    node: process.version,
    git: gitVersion || "unknown",
    repo: config.label,
    path: config.showPath ? config.cwd : "redacted",
    files: formatCount(summary.fileCount),
    dirs: formatCount(summary.dirCount),
    gitStatus: summary.gitStatus,
  }
}

function buildScenarios(config: BenchConfig, files: string[], dirs: string[]): Scenario[] {
  const smallPatch = makeSyntheticPatch(5)
  const largePatch = makeSyntheticPatch(500)

  return [
    {
      name: "file scan: rg --files",
      group: "file",
      run: async () => {
        const result = await runRgFiles(config.cwd)
        return {
          spawnCount: result.spawnCount,
          resultCount: result.files.length,
          outputBytes: result.stdout.length,
        }
      },
    },
    {
      name: "file index approximation: dirs cache",
      group: "file",
      run: async () => {
        if (files.length === 0) throw new SkipScenario("rg --files unavailable during setup")
        const next = { files: [] as string[], dirs: [] as string[] }
        const seen = new Set<string>()
        for (const file of files) {
          next.files.push(file)
          const parts = file.split(/[\\/]/).filter(Boolean)
          for (let i = 1; i < parts.length; i++) {
            const dir = `${parts.slice(0, i).join("/")}/`
            if (seen.has(dir)) continue
            seen.add(dir)
            next.dirs.push(dir)
          }
        }
        return {
          spawnCount: 0,
          resultCount: next.dirs.length,
          outputBytes: 0,
          notes: "approximation; uses rg file list captured before scenario timing",
        }
      },
    },
    {
      name: "file fuzzy search approximation",
      group: "file",
      run: async () => {
        if (files.length === 0) throw new SkipScenario("rg --files unavailable during setup")
        const items = [...files, ...dirs]
        let resultCount = 0
        for (const query of scenarioQueries) {
          resultCount += fuzzysort.go(query, items, { limit: 100 }).length
        }
        return {
          spawnCount: 0,
          resultCount,
          outputBytes: 0,
          notes: "approximation; fixed queries over captured file and dir list",
        }
      },
    },
    {
      name: "git status",
      group: "git",
      run: async () => {
        const result = await runGit(
          ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."],
          config.cwd,
        )
        if (result.code !== 0) throw new SkipScenario("git status unavailable for this cwd")
        return {
          spawnCount: result.spawnCount,
          resultCount: parseStatusCount(result.stdout),
          outputBytes: result.stdout.length,
        }
      },
    },
    {
      name: "git diff name-status",
      group: "git",
      run: async () => {
        const result = await runGit(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", "HEAD", "--", "."], config.cwd)
        if (result.code !== 0) throw new SkipScenario("git diff name-status unavailable for this cwd")
        return {
          spawnCount: result.spawnCount,
          resultCount: parseNameStatusCount(result.stdout),
          outputBytes: result.stdout.length,
        }
      },
    },
    {
      name: "git diff numstat",
      group: "git",
      run: async () => {
        const result = await runGit(["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", "HEAD", "--", "."], config.cwd)
        if (result.code !== 0) throw new SkipScenario("git diff numstat unavailable for this cwd")
        const stats = parseNumstat(result.stdout)
        return {
          spawnCount: result.spawnCount,
          resultCount: stats.files,
          outputBytes: result.stdout.length,
          notes: `additions=${stats.additions}; deletions=${stats.deletions}`,
        }
      },
    },
    {
      name: "git worktree list parse",
      group: "git",
      run: async () => {
        const result = await runGit(["worktree", "list", "--porcelain"], config.cwd)
        if (result.code !== 0) throw new SkipScenario("git worktree list unavailable for this cwd")
        return {
          spawnCount: result.spawnCount,
          resultCount: parseWorktreeCount(result.stdout),
          outputBytes: result.stdout.length,
        }
      },
    },
    {
      name: "apply_patch parse small",
      group: "patch",
      run: async () => {
        const parsed = Patch.parsePatch(smallPatch)
        return {
          spawnCount: 0,
          resultCount: parsed.hunks.length,
          outputBytes: Buffer.byteLength(smallPatch),
          notes: "synthetic patch; parse only",
        }
      },
    },
    {
      name: "apply_patch parse large",
      group: "patch",
      run: async () => {
        const parsed = Patch.parsePatch(largePatch)
        return {
          spawnCount: 0,
          resultCount: parsed.hunks.length,
          outputBytes: Buffer.byteLength(largePatch),
          notes: "synthetic patch; parse only",
        }
      },
    },
    {
      name: "process spawn noop",
      group: "process",
      run: async () => {
        const result = await Process.run([process.execPath, "-e", "0"], { nothrow: true })
        return {
          spawnCount: 1,
          resultCount: result.code,
          outputBytes: result.stdout.length + result.stderr.length,
          notes: `exitCode=${result.code}`,
        }
      },
    },
    {
      name: "process timeout abort",
      group: "process",
      run: async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 50)
        try {
          const result = await Process.run([process.execPath, "-e", "setTimeout(() => {}, 5000)"], {
            abort: controller.signal,
            nothrow: true,
            timeout: 50,
          })
          return {
            spawnCount: 1,
            resultCount: result.code,
            outputBytes: result.stdout.length + result.stderr.length,
            notes: `exitCode=${result.code}`,
          }
        } finally {
          clearTimeout(timer)
          await delay(0)
        }
      },
    },
  ]
}

function formatMarkdown(env: Environment, results: BenchResult[]) {
  const lines = [
    `## Native-core baseline - ${new Date().toISOString().slice(0, 10)}`,
    "",
    "Environment:",
    `- OS: ${env.os}`,
    `- CPU: ${env.cpu}`,
    `- Bun: ${env.bun}`,
    `- Node: ${env.node}`,
    `- Git: ${env.git}`,
    `- Repo: ${env.repo}`,
    `- Path: ${env.path}`,
    `- Files: ${env.files}`,
    `- Dirs: ${env.dirs}`,
    `- Git status: ${env.gitStatus}`,
    "",
    "| Scenario | First run | Repeat p50 | Repeat p95 | Spawn count | Result count | Output bytes | Notes |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
  ]

  for (const result of results) {
    lines.push(
      [
        result.name,
        result.status === "ok" ? formatMs(result.firstRunMs) : result.status,
        result.status === "ok" ? formatMs(result.repeatP50Ms) : result.status,
        result.status === "ok" ? formatMs(result.repeatP95Ms) : result.status,
        result.status === "ok" ? formatCount(result.spawnCount) : "",
        result.status === "ok" ? formatCount(result.resultCount) : "",
        result.status === "ok" ? formatCount(result.outputBytes) : "",
        sanitizeCell(result.notes ?? ""),
      ]
        .map((cell) => ` ${cell} `)
        .join("|")
        .replace(/^/, "|")
        .replace(/$/, "|"),
    )
  }

  return lines.join("\n")
}

function formatMs(ms?: number) {
  if (ms === undefined) return "n/a"
  if (ms < 10) return `${ms.toFixed(2)}ms`
  if (ms < 100) return `${ms.toFixed(1)}ms`
  return `${Math.round(ms)}ms`
}

function formatCount(value?: number) {
  return value === undefined ? "unknown" : new Intl.NumberFormat("en-US").format(value)
}

function sanitizeCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim()
}

function sanitizeError(error: unknown, cwd?: string) {
  const raw = error instanceof Error ? error.message : String(error)
  let text = raw.replace(/\s+/g, " ").trim()
  if (cwd) text = text.split(cwd).join("[cwd]")
  text = text.split(os.homedir()).join("[home]")
  if (text.length > 180) text = `${text.slice(0, 177)}...`
  return text || "unknown error"
}

async function main() {
  let config: BenchConfig
  try {
    config = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(sanitizeError(error))
    console.error("")
    console.error(usage)
    process.exit(1)
  }

  const fileSummary = await collectFileSummary(config.cwd)
  const repoSummary = await collectRepoSummary(config.cwd, fileSummary.fileCount, fileSummary.dirCount)
  const env = await collectEnvironment(config, repoSummary)
  const scenarios = buildScenarios(config, fileSummary.files, fileSummary.dirs).filter((scenario) =>
    scenarioMatches(config.scenario, scenario),
  )

  if (scenarios.length === 0) {
    console.error(`No scenario matched: ${config.scenario}`)
    process.exit(1)
  }

  const results: BenchResult[] = []
  for (const scenario of scenarios) {
    results.push(await benchScenario(scenario, config))
  }

  console.log(formatMarkdown(env, results))

  if (!results.some((result) => result.status === "ok")) process.exit(1)
}

await main()
