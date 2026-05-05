#!/usr/bin/env bun

import { Buffer } from "node:buffer"
import fs from "node:fs/promises"
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
  layer: "production path" | "CLI floor" | "approximation"
  group: "file" | "git" | "patch" | "process"
  run: () => Promise<Omit<RunMetrics, "durationMs">>
}

type BenchResult = {
  name: string
  layer: Scenario["layer"]
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
  ripgrep: string
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

const commandTimeoutMs = 30_000
const maxIterations = 100
const maxWarmups = 20

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

const rgFilesArgs = ["--no-config", "--files", "--hidden", "-0", "--glob=!.git/*", "."] as const

const scenarioQueries = ["session", "worktree", "git", "index", "config"] as const

const usage = `Usage:
  bun --cwd packages/opencode ./script/bench-native-candidates.ts --cwd /path/to/repo [options]

Options:
  --cwd <path>           Required repo or workspace path to benchmark
  --label <name>         Output repo label, defaults to basename(cwd)
  --iterations <n>       Measured repeat runs, defaults to 7
  --warmups <n>          Warmup runs before repeat measurements, defaults to 2
  --show-path            Print the full cwd path instead of redacting it
  --scenario <name|all>  Run one scenario by exact or slug name, or all scenarios
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
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag} must be a positive integer`)
  const n = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(n)) throw new Error(`${flag} is too large`)
  if (flag === "--iterations" && n > maxIterations) throw new Error(`${flag} must be <= ${maxIterations}`)
  return n
}

function parseNonNegativeInteger(flag: string, value: string) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${flag} must be a non-negative integer`)
  const n = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(n)) throw new Error(`${flag} is too large`)
  if (flag === "--warmups" && n > maxWarmups) throw new Error(`${flag} must be <= ${maxWarmups}`)
  return n
}

async function runCommand(cmd: string[], cwd: string): Promise<CommandResult> {
  if (cmd.length === 0) throw new Error("Command is required")
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
  let timedOut = false
  let forceKill: Timer | undefined
  const timeout = setTimeout(() => {
    timedOut = true
    proc?.kill("SIGTERM")
    forceKill = setTimeout(() => proc?.kill("SIGKILL"), 500)
  }, commandTimeoutMs)
  try {
    proc = Bun.spawn(cmd, {
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
    if (timedOut) throw new Error(`command timed out after ${commandTimeoutMs}ms`)
    return {
      code,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr),
      spawnCount: 1,
    }
  } catch (error) {
    throw new Error(sanitizeError(error, cwd))
  } finally {
    clearTimeout(timeout)
    if (forceKill) clearTimeout(forceKill)
  }
}

async function validateCwd(cwd: string) {
  let stat
  try {
    stat = await fs.stat(cwd)
  } catch {
    throw new Error(`--cwd does not exist: ${cwd}`)
  }
  if (!stat.isDirectory()) throw new Error(`--cwd is not a directory: ${cwd}`)
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
    files: splitNul(result.stdout.toString()),
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

function scenarioSlugList(scenarios: Scenario[]) {
  return scenarios.map((scenario) => `  - ${slug(scenario.name)}`).join("\n")
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
      layer: scenario.layer,
      group: scenario.group,
      status: "skipped",
      notes: first.notes,
    }
  }
  if (first.status === "error") {
    return {
      name: scenario.name,
      layer: scenario.layer,
      group: scenario.group,
      status: "error",
      notes: first.error,
    }
  }

  for (let i = 0; i < config.warmups; i++) {
    const warmup = await timed(scenario.run)
    if (warmup.status === "skipped") {
      return {
        name: scenario.name,
        layer: scenario.layer,
        group: scenario.group,
        status: "skipped",
        notes: warmup.notes,
      }
    }
    if (warmup.status === "error") {
      return {
        name: scenario.name,
        layer: scenario.layer,
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
        layer: scenario.layer,
        group: scenario.group,
        status: "skipped",
        notes: run.notes,
      }
    }
    if (run.status === "error") {
      return {
        name: scenario.name,
        layer: scenario.layer,
        group: scenario.group,
        status: "error",
        notes: run.error,
      }
    }
    measured.push(run.metrics)
  }

  return {
    name: scenario.name,
    layer: scenario.layer,
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
  const parts = splitNul(stdout.toString())
  let count = 0
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i]
    const code = item.slice(0, 2)
    const file = item.slice(3)
    if (!code.trim() || !file) continue
    count++
    if (code.includes("R") || code.includes("C")) i++
  }
  return count
}

function parseNameStatusCount(stdout: Buffer) {
  const parts = splitNul(stdout.toString())
  let count = 0
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++]
    if (!code) continue
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = parts[i++]
      const newPath = parts[i++]
      if (oldPath && newPath) count++
      continue
    }
    const file = parts[i++]
    if (file) count++
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
  const ripgrepVersion = await runCommand(["rg", "--version"], config.cwd)
    .then((result) => (result.code === 0 ? splitLines(result.stdout.toString("utf8"))[0] : "unknown"))
    .catch(() => "unknown")
  const cpu = os.cpus()[0]
  return {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: cpu ? `${cpu.model}, ${os.cpus().length} cores` : "unknown",
    bun: Bun.version,
    node: process.version,
    git: gitVersion || "unknown",
    ripgrep: `${ripgrepVersion || "unknown"}; source=system PATH`,
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
      layer: "CLI floor",
      group: "file",
      run: async () => {
        const result = await runRgFiles(config.cwd)
        return {
          spawnCount: result.spawnCount,
          resultCount: result.files.length,
          outputBytes: result.stdout.length,
          notes: "CLI floor; system PATH rg; production Ripgrep.Service may add managed binary/env/stream cleanup overhead",
        }
      },
    },
    {
      name: "file index approximation: dirs cache",
      layer: "approximation",
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
      layer: "approximation",
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
      layer: "CLI floor",
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
          notes: "CLI floor; mirrors Git args but bypasses Git.Service spawner wrapper",
        }
      },
    },
    {
      name: "git diff name-status",
      layer: "CLI floor",
      group: "git",
      run: async () => {
        const result = await runGit(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", "HEAD", "--", "."], config.cwd)
        if (result.code !== 0) throw new SkipScenario("git diff name-status unavailable for this cwd")
        return {
          spawnCount: result.spawnCount,
          resultCount: parseNameStatusCount(result.stdout),
          outputBytes: result.stdout.length,
          notes: "CLI floor; mirrors Git args but bypasses Git.Service spawner wrapper",
        }
      },
    },
    {
      name: "git diff numstat",
      layer: "CLI floor",
      group: "git",
      run: async () => {
        const result = await runGit(["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", "HEAD", "--", "."], config.cwd)
        if (result.code !== 0) throw new SkipScenario("git diff numstat unavailable for this cwd")
        const stats = parseNumstat(result.stdout)
        return {
          spawnCount: result.spawnCount,
          resultCount: stats.files,
          outputBytes: result.stdout.length,
          notes: `CLI floor; mirrors Git args but bypasses Git.Service spawner wrapper; additions=${stats.additions}; deletions=${stats.deletions}`,
        }
      },
    },
    {
      name: "git worktree list parse",
      layer: "CLI floor",
      group: "git",
      run: async () => {
        const result = await runGit(["worktree", "list", "--porcelain"], config.cwd)
        if (result.code !== 0) throw new SkipScenario("git worktree list unavailable for this cwd")
        return {
          spawnCount: result.spawnCount,
          resultCount: parseWorktreeCount(result.stdout),
          outputBytes: result.stdout.length,
          notes: "CLI floor; parses porcelain output without Worktree service orchestration",
        }
      },
    },
    {
      name: "apply_patch parse small",
      layer: "production path",
      group: "patch",
      run: async () => {
        const parsed = Patch.parsePatch(smallPatch)
        return {
          spawnCount: 0,
          resultCount: parsed.hunks.length,
          outputBytes: Buffer.byteLength(smallPatch),
          notes: "synthetic patch; parse only; not a verify/preview/content replacement benchmark",
        }
      },
    },
    {
      name: "apply_patch parse large",
      layer: "production path",
      group: "patch",
      run: async () => {
        const parsed = Patch.parsePatch(largePatch)
        return {
          spawnCount: 0,
          resultCount: parsed.hunks.length,
          outputBytes: Buffer.byteLength(largePatch),
          notes: "synthetic patch; parse only; 500 update chunks in one file hunk; not a verify/preview/content replacement benchmark",
        }
      },
    },
    {
      name: "process spawn noop",
      layer: "production path",
      group: "process",
      run: async () => {
        const result = await Process.run([process.execPath, "-e", "0"], { nothrow: true })
        return {
          spawnCount: 1,
          outputBytes: result.stdout.length + result.stderr.length,
          notes: `exitCode=${result.code}`,
        }
      },
    },
    {
      name: "process timeout abort",
      layer: "production path",
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
            outputBytes: result.stdout.length + result.stderr.length,
            notes: `single-process abort only; no process-tree fixture in first PR; exitCode=${result.code}`,
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
    `- OS: ${escapeMarkdownInline(env.os)}`,
    `- CPU: ${escapeMarkdownInline(env.cpu)}`,
    `- Bun: ${escapeMarkdownInline(env.bun)}`,
    `- Node: ${escapeMarkdownInline(env.node)}`,
    `- Git: ${escapeMarkdownInline(env.git)}`,
    `- Ripgrep: ${escapeMarkdownInline(env.ripgrep)}`,
    `- Repo: ${escapeMarkdownInline(env.repo)}`,
    `- Path: ${escapeMarkdownInline(env.path)}`,
    `- Files: ${escapeMarkdownInline(env.files)}`,
    `- Dirs: ${escapeMarkdownInline(env.dirs)}`,
    `- Git status: ${escapeMarkdownInline(env.gitStatus)}`,
    "- Setup note: file/repo summary collection runs before scenario timing, so first measured values are not cold-start measurements.",
    "",
    "| Scenario | Layer | First measured | Repeat p50 | Repeat p95 | Spawn count | Result count | Output bytes | Notes |",
    "|---|---|---:|---:|---:|---:|---:|---:|---|",
  ]

  for (const result of results) {
    lines.push(
      [
        result.name,
        result.layer,
        result.status === "ok" ? formatMs(result.firstRunMs) : result.status,
        result.status === "ok" ? formatMs(result.repeatP50Ms) : result.status,
        result.status === "ok" ? formatMs(result.repeatP95Ms) : result.status,
        result.status === "ok" ? formatMetricCount(result.spawnCount) : "",
        result.status === "ok" ? formatMetricCount(result.resultCount) : "",
        result.status === "ok" ? formatMetricCount(result.outputBytes) : "",
        result.notes ?? "",
      ]
        .map((cell) => ` ${escapeMarkdownTableCell(cell)} `)
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

function formatMetricCount(value?: number) {
  return value === undefined ? "" : new Intl.NumberFormat("en-US").format(value)
}

function escapeMarkdownInline(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim()
}

function escapeMarkdownTableCell(value: string) {
  return escapeMarkdownInline(value)
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

  try {
    await validateCwd(config.cwd)
  } catch (error) {
    console.error(sanitizeError(error, config.cwd))
    process.exit(1)
  }

  const fileSummary = await collectFileSummary(config.cwd)
  const repoSummary = await collectRepoSummary(config.cwd, fileSummary.fileCount, fileSummary.dirCount)
  const env = await collectEnvironment(config, repoSummary)
  const allScenarios = buildScenarios(config, fileSummary.files, fileSummary.dirs)
  const scenarios = allScenarios.filter((scenario) => scenarioMatches(config.scenario, scenario))

  if (scenarios.length === 0) {
    console.error(`No scenario matched: ${config.scenario}`)
    console.error("Available scenario slugs:")
    console.error(scenarioSlugList(allScenarios))
    process.exit(1)
  }

  const results: BenchResult[] = []
  for (const scenario of scenarios) {
    results.push(await benchScenario(scenario, config))
  }

  console.log(formatMarkdown(env, results))

  if (results.some((result) => result.status === "error")) process.exit(1)
  if (!results.some((result) => result.status === "ok")) process.exit(1)
}

await main()
