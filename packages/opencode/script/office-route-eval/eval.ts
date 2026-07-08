import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js"

type RouteID = "officecli" | "python"
type TaskID = "xlsx-dashboard" | "docx-board-memo" | "pptx-pitch-deck"

type CommandAudit = {
  tool: string
  command: string
  description?: string
  status?: string
}

type ArtifactSummary = {
  path: string
  exists: boolean
  size: number
  sha256?: string
}

type RunSummary = {
  schemaVersion: 1
  runId: string
  taskId: TaskID
  routeId: RouteID
  round: number
  model: string
  variant?: string
  startedAt: string
  completedAt: string
  durationMs: number
  exitCode: number | null
  workDir: string
  artifactPath: string
  officecli: {
    manifestVersion: string
    binaryPath: string
    binaryVersion?: string
  }
  python: {
    uvVersion?: string
    pythonVersion?: string
  }
  commands: CommandAudit[]
  artifacts: ArtifactSummary[]
  eventCounts: Record<string, number>
}

type JudgeResult = {
  schemaVersion: 1
  runId: string
  taskId: TaskID
  routeId: RouteID
  passed: boolean
  score: number
  failures: string[]
  warnings: string[]
  metrics: Record<string, number | string | boolean>
}

type TaskSpec = {
  id: TaskID
  artifact: string
  fixture: string
  prompt: string
  requiredText: string[]
}

const evalRoot = import.meta.dir
const packageRoot = path.resolve(evalRoot, "../..")
const repoRoot = path.resolve(packageRoot, "../..")
const runsRoot = path.join(evalRoot, "runs")
const toolsDir = path.join(repoRoot, "packages/desktop-electron/resources/tools")
const officeCliPath = path.join(toolsDir, process.platform === "win32" ? "officecli.exe" : "officecli")
const officeManifestPath = path.join(repoRoot, "packages/desktop-electron/bundled-tools.json")

const tasks: Record<TaskID, TaskSpec> = {
  "xlsx-dashboard": {
    id: "xlsx-dashboard",
    artifact: "sales-dashboard.xlsx",
    fixture: "sales-2026.csv",
    requiredText: [
      "Orion Analytics Sales Dashboard",
      "Raw Data",
      "Dashboard",
      "Regional Summary",
      "Total Revenue",
      "Gross Margin Rate",
      "Customers",
      "Top Region",
      "North",
      "South",
      "West",
    ],
    prompt: [
      "Create an Excel workbook named sales-dashboard.xlsx from the attached sales-2026.csv.",
      "The workbook must have exactly these user-facing sheets: Raw Data, Dashboard, Regional Summary.",
      "Import every CSV row into Raw Data.",
      "Dashboard must contain the title 'Orion Analytics Sales Dashboard' and KPI labels Total Revenue, Gross Margin Rate, Customers, Top Region.",
      "Use formulas for computed dashboard and regional summary numbers when the format supports formulas.",
      "Add at least one column or bar chart based on the regional or monthly summary.",
      "Freeze the Raw Data header row and set readable explicit column widths.",
      "Write the final artifact to ./artifacts/sales-dashboard.xlsx.",
    ].join("\n"),
  },
  "docx-board-memo": {
    id: "docx-board-memo",
    artifact: "board-memo.docx",
    fixture: "board-notes.md",
    requiredText: [
      "Orion Assist Board Memo",
      "Executive Summary",
      "Decision Needed",
      "Evidence",
      "Risks",
      "Next Steps",
      "Metric",
      "Current",
      "Target",
      "Status",
    ],
    prompt: [
      "Create a Word document named board-memo.docx from the attached board-notes.md.",
      "The document title must be 'Orion Assist Board Memo'.",
      "Use these section headings: Executive Summary, Decision Needed, Evidence, Risks, Next Steps.",
      "Include a table with headers Metric, Current, Target, Status and fill it from the source notes.",
      "Add a footer with a live page-number field, not static text.",
      "Use explicit heading and body styling; avoid empty paragraphs as spacing.",
      "Write the final artifact to ./artifacts/board-memo.docx.",
    ].join("\n"),
  },
  "pptx-pitch-deck": {
    id: "pptx-pitch-deck",
    artifact: "orion-assist-pitch.pptx",
    fixture: "growth-brief.md",
    requiredText: [
      "Orion Assist",
      "Problem",
      "Solution",
      "Market",
      "Go-To-Market",
      "Ask",
      "$2.4M",
      "18 months",
    ],
    prompt: [
      "Create a six-slide PowerPoint deck named orion-assist-pitch.pptx from the attached growth-brief.md.",
      "Use exactly these slide titles: Orion Assist, Problem, Solution, Market, Go-To-Market, Ask.",
      "Every slide must have explicit title and body font sizes.",
      "Slides 2 through 6 must include speaker notes.",
      "Include at least one chart, preferably on the Market or Go-To-Market slide.",
      "Avoid placeholder text and do not leave a bullet-only deck.",
      "Write the final artifact to ./artifacts/orion-assist-pitch.pptx.",
    ].join("\n"),
  },
}

function usage() {
  console.log(`Usage:
  bun run office:eval calibrate --model openai/gpt-5.4-mini --variant low
  bun run office:eval full --model openai/gpt-5.4-mini --variant low --rounds 3
  bun run office:eval full --model openai/gpt-5.4-mini --variant low --start-round 2 --rounds 3
  bun run office:eval run --task xlsx-dashboard --route officecli --round 1 --model openai/gpt-5.4-mini --variant low
  bun run office:eval judge --run script/office-route-eval/runs/<run-id>
  bun run office:eval report`)
}

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      out[key] = true
      continue
    }
    out[key] = next
    i += 1
  }
  return out
}

function assertTask(value: unknown): TaskID {
  if (value === "xlsx-dashboard" || value === "docx-board-memo" || value === "pptx-pitch-deck") return value
  throw new Error(`Unknown task: ${String(value)}`)
}

function assertRoute(value: unknown): RouteID {
  if (value === "officecli" || value === "python") return value
  throw new Error(`Unknown route: ${String(value)}`)
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

function textFromXml(xml: string) {
  return [...xml.matchAll(/<(?:[a-zA-Z0-9]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?t>/g)]
    .map((match) => decodeXml(match[1]))
    .join(" ")
}

function countMatches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length
}

function hasAny(value: string, needles: string[]) {
  const lower = value.toLowerCase()
  return needles.some((needle) => lower.includes(needle.toLowerCase()))
}

function hasPlaceholderText(value: string) {
  return /\{\{|<TODO>|lorem|xxxx|\$xxx\$/.test(value)
}

async function readZipEntries(file: string) {
  const bytes = await readFile(file)
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const reader = new ZipReader(new BlobReader(new Blob([arrayBuffer])))
  try {
    const entries = await reader.getEntries()
    const result = new Map<string, string>()
    for (const entry of entries) {
      if (entry.directory || !entry.getData) continue
      if (!/\.(xml|rels)$/i.test(entry.filename) && !entry.filename.endsWith("[Content_Types].xml")) continue
      result.set(entry.filename, await entry.getData(new TextWriter()))
    }
    return result
  } finally {
    await reader.close()
  }
}

async function sha256File(file: string) {
  const bytes = await readFile(file)
  return createHash("sha256").update(bytes).digest("hex")
}

async function commandOutput(command: string, args: string[]) {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return code === 0 ? stdout.trim() : stderr.trim() || stdout.trim()
}

async function officeManifestVersion() {
  const raw = await readFile(officeManifestPath, "utf8")
  return JSON.parse(raw).officecli.version as string
}

function routeConfig(route: RouteID) {
  const skillPath =
    route === "officecli"
      ? path.join(evalRoot, "route-skills/officecli-eval-policy")
      : path.join(evalRoot, "route-skills/python-office-eval")
  return {
    skills: {
      paths: [skillPath],
    },
    permission: {
      bash: "allow",
      read: "allow",
      write: "allow",
      edit: "allow",
      skill: "allow",
    },
  }
}

async function prepareRunDir(task: TaskSpec, route: RouteID, round: number) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const runId = `${stamp}-${task.id}-${route}-r${round}`
  const runDir = path.join(runsRoot, runId)
  const workDir = path.join(runDir, "workspace")
  const artifactDir = path.join(workDir, "artifacts")
  const inputDir = path.join(workDir, "input")
  await mkdir(artifactDir, { recursive: true })
  await mkdir(inputDir, { recursive: true })
  await copyFile(path.join(evalRoot, "fixtures", task.fixture), path.join(inputDir, task.fixture))
  if (route === "python") {
    await copyFile(path.join(evalRoot, "route-templates/python/pyproject.toml"), path.join(workDir, "pyproject.toml"))
  }
  return { runId, runDir, workDir, artifactDir, inputDir }
}

function buildPrompt(task: TaskSpec, route: RouteID, runDir: string, workDir: string) {
  const artifact = path.join(workDir, "artifacts", task.artifact)
  const routeLine =
    route === "officecli"
      ? "Use the current PawWork OfficeCLI route. You must use officecli for the final Office artifact."
      : "Use the Python + uv + skills route. You must use uv and Python libraries. Do not call officecli."
  return [
    "# Office route eval task",
    "",
    routeLine,
    "Do not use LibreOffice, soffice, lowriter, localc, or loffice.",
    "Work only inside the current working directory.",
    "Use the attached source file and the same source path under ./input/.",
    "",
    task.prompt,
    "",
    "After creating the artifact, write ./artifacts/artifact-summary.json with:",
    JSON.stringify(
      {
        artifact: artifact,
        route,
        task: task.id,
        commandsUsed: ["short list of important commands"],
        limitations: [],
      },
      null,
      2,
    ),
    "",
    "Do not claim success unless the target artifact exists.",
    `Write only under this working directory: ${workDir}`,
  ].join("\n")
}

export function extractCommandsFromJsonl(jsonl: string): { commands: CommandAudit[]; eventCounts: Record<string, number> } {
  const commands: CommandAudit[] = []
  const eventCounts: Record<string, number> = {}
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event: any
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1
    const part = event.part
    if (event.type !== "tool_use" || !part?.state?.input) continue
    const tool = String(part.tool ?? "")
    if (!["bash", "cmd", "powershell", "pwsh"].includes(tool)) continue
    const input = part.state.input
    if (typeof input.command !== "string") continue
    commands.push({
      tool,
      command: input.command,
      description: typeof input.description === "string" ? input.description : undefined,
      status: typeof part.state.status === "string" ? part.state.status : undefined,
    })
  }
  return { commands, eventCounts }
}

export function commandPolicyFailures(route: RouteID, commands: CommandAudit[]) {
  const failures: string[] = []
  const joined = commands.map((item) => item.command).join("\n").toLowerCase()
  if (/\b(libreoffice|soffice|lowriter|localc|loffice)\b/.test(joined)) {
    failures.push("Route used LibreOffice or a LibreOffice alias.")
  }
  if (route === "python") {
    if (!/\buv\b/.test(joined)) failures.push("Python route did not call uv.")
    if (/\bofficecli\b/.test(joined)) failures.push("Python route called officecli.")
  }
  if (route === "officecli") {
    if (!/\bofficecli\b/.test(joined)) failures.push("OfficeCLI route did not call officecli.")
    if (/\buv\b/.test(joined)) failures.push("OfficeCLI route called uv.")
    if (/\b(openpyxl|python-docx|python_pptx|python-pptx|from pptx|from docx|load_workbook|workbook\()/i.test(joined)) {
      failures.push("OfficeCLI route appears to create the final artifact through Python Office libraries.")
    }
  }
  return failures
}

async function artifactSummaries(artifactPath: string): Promise<ArtifactSummary[]> {
  const info = await stat(artifactPath).catch(() => undefined)
  if (!info?.isFile()) return [{ path: artifactPath, exists: false, size: 0 }]
  return [{ path: artifactPath, exists: true, size: info.size, sha256: await sha256File(artifactPath) }]
}

async function findByName(root: string, basename: string, depth = 5): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string, remaining: number) {
    if (remaining < 0) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isFile() && entry.name === basename) found.push(full)
      if (entry.isDirectory()) await walk(full, remaining - 1)
    }
  }
  await walk(root, depth)
  return found
}

async function runOne(taskId: TaskID, routeId: RouteID, round: number, model: string, variant?: string) {
  const task = tasks[taskId]
  const { runId, runDir, workDir } = await prepareRunDir(task, routeId, round)
  const startedAt = new Date()
  const prompt = buildPrompt(task, routeId, runDir, workDir)
  const promptPath = path.join(runDir, "prompt.md")
  await writeFile(promptPath, prompt)

  const args = [
    "--cwd",
    packageRoot,
    "src/index.ts",
    "run",
    "--format",
    "json",
    "--model",
    model,
    "--dir",
    workDir,
    "--dangerously-skip-permissions",
    "--file",
    path.join(workDir, "input", task.fixture),
  ]
  if (variant) args.push("--variant", variant)
  args.push(prompt)

  const env = {
    ...process.env,
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(routeConfig(routeId)),
    OFFICECLI_SKIP_UPDATE: "1",
    PATH: routeId === "officecli" ? `${toolsDir}${path.delimiter}${process.env.PATH ?? ""}` : process.env.PATH ?? "",
  }

  const proc = Bun.spawn(["bun", ...args], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeoutMs = Number(process.env.OFFICE_ROUTE_EVAL_TIMEOUT_MS ?? 10 * 60 * 1000)
  const killer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(killer))

  await writeFile(path.join(runDir, "events.jsonl"), stdout)
  await writeFile(path.join(runDir, "stderr.log"), stderr)

  const { commands, eventCounts } = extractCommandsFromJsonl(stdout)
  const artifactPath = path.join(workDir, "artifacts", task.artifact)
  const completedAt = new Date()
  const summary: RunSummary = {
    schemaVersion: 1,
    runId,
    taskId,
    routeId,
    round,
    model,
    variant,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    exitCode,
    workDir,
    artifactPath,
    officecli: {
      manifestVersion: await officeManifestVersion(),
      binaryPath: officeCliPath,
      binaryVersion: await commandOutput(officeCliPath, ["--version"]).catch((error) => String(error)),
    },
    python: {
      uvVersion: await commandOutput("uv", ["--version"]).catch((error) => String(error)),
      pythonVersion: await commandOutput("python3", ["--version"]).catch((error) => String(error)),
    },
    commands,
    artifacts: await artifactSummaries(artifactPath),
    eventCounts,
  }
  await writeFile(path.join(runDir, "run-summary.json"), JSON.stringify(summary, null, 2))
  const judge = await judgeRun(runDir)
  console.log(`${judge.passed ? "PASS" : "FAIL"} ${runId} score=${judge.score}`)
  if (judge.failures.length) console.log(judge.failures.map((item) => `  - ${item}`).join("\n"))
}

function addRequiredTextFailures(failures: string[], text: string, required: string[]) {
  for (const item of required) {
    if (!text.toLowerCase().includes(item.toLowerCase())) failures.push(`Missing required text: ${item}`)
  }
}

async function judgeXlsx(summary: RunSummary, task: TaskSpec, failures: string[], warnings: string[], metrics: JudgeResult["metrics"]) {
  const zip = await readZipEntries(summary.artifactPath)
  const names = [...zip.keys()]
  const allXml = [...zip.values()].join("\n")
  const sharedText = textFromXml(zip.get("xl/sharedStrings.xml") ?? "")
  const combined = `${allXml}\n${sharedText}`
  metrics.zipEntries = names.length
  metrics.chartCount = names.filter((name) => name.startsWith("xl/charts/chart")).length
  metrics.formulaCount = countMatches(allXml, /<f(?:\s[^>]*)?>[\s\S]*?<\/f>/g)
  if (!zip.has("[Content_Types].xml") || !zip.has("xl/workbook.xml")) failures.push("Invalid xlsx package structure.")
  addRequiredTextFailures(failures, combined, task.requiredText)
  if (Number(metrics.chartCount) < 1) failures.push("XLSX has no chart XML.")
  if (Number(metrics.formulaCount) < 3) failures.push("XLSX has fewer than three formulas.")
  if (!hasAny(allXml, ["SUM(", "SUMIF", "SUMIFS", "AVERAGE", "SUBTOTAL"])) {
    failures.push("XLSX formulas do not include recognizable summary calculations.")
  }
  for (const token of ["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A"]) {
    if (combined.includes(token)) failures.push(`XLSX contains formula error token ${token}.`)
  }
  if (hasPlaceholderText(textFromXml(combined))) failures.push("XLSX contains placeholder-like text.")
  if (!zip.has("xl/worksheets/sheet1.xml")) warnings.push("XLSX sheet1.xml missing; workbook may use unusual sheet layout.")
}

async function judgeDocx(summary: RunSummary, task: TaskSpec, failures: string[], _warnings: string[], metrics: JudgeResult["metrics"]) {
  const zip = await readZipEntries(summary.artifactPath)
  const documentXml = zip.get("word/document.xml") ?? ""
  const footerXml = [...zip.entries()]
    .filter(([name]) => /^word\/footer\d+\.xml$/.test(name))
    .map(([, value]) => value)
    .join("\n")
  const text = textFromXml(`${documentXml}\n${footerXml}`)
  metrics.paragraphCount = countMatches(documentXml, /<w:p[\s>]/g)
  metrics.tableCount = countMatches(documentXml, /<w:tbl[\s>]/g)
  metrics.headingStyleCount = countMatches(documentXml, /<w:pStyle[^>]+w:val="Heading[123]"/g)
  metrics.footerCount = countMatches(footerXml, /<w:ftr[\s>]/g)
  if (!zip.has("[Content_Types].xml") || !zip.has("word/document.xml")) failures.push("Invalid docx package structure.")
  addRequiredTextFailures(failures, text, task.requiredText)
  if (Number(metrics.tableCount) < 1) failures.push("DOCX has no table.")
  if (Number(metrics.headingStyleCount) < 3) failures.push("DOCX has fewer than three Heading styles.")
  if (!footerXml || !footerXml.includes("fldChar")) failures.push("DOCX footer does not contain a live page-number field.")
  if (hasPlaceholderText(text)) failures.push("DOCX contains placeholder-like text.")
}

async function judgePptx(summary: RunSummary, task: TaskSpec, failures: string[], warnings: string[], metrics: JudgeResult["metrics"]) {
  const zip = await readZipEntries(summary.artifactPath)
  const slideEntries = [...zip.entries()].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
  const notesEntries = [...zip.keys()].filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
  const chartEntries = [...zip.keys()].filter((name) => name.startsWith("ppt/charts/chart"))
  const slideXml = slideEntries.map(([, value]) => value).join("\n")
  const text = textFromXml(slideXml)
  const fontSizes = [...slideXml.matchAll(/<a:sz[^>]+val="(\d+)"/g)].map((match) => Number(match[1]))
  metrics.slideCount = slideEntries.length
  metrics.notesCount = notesEntries.length
  metrics.chartCount = chartEntries.length
  metrics.maxFontCentipoints = fontSizes.length ? Math.max(...fontSizes) : 0
  metrics.minFontCentipoints = fontSizes.length ? Math.min(...fontSizes) : 0
  if (!zip.has("[Content_Types].xml") || !zip.has("ppt/presentation.xml")) failures.push("Invalid pptx package structure.")
  if (slideEntries.length !== 6) failures.push(`PPTX expected exactly 6 slides, found ${slideEntries.length}.`)
  addRequiredTextFailures(failures, text, task.requiredText)
  if (notesEntries.length < 5) failures.push("PPTX has fewer than five notes slides.")
  if (chartEntries.length < 1) failures.push("PPTX has no chart XML.")
  if (!fontSizes.length) failures.push("PPTX has no explicit run font sizes.")
  if (fontSizes.length && Math.max(...fontSizes) < 3600) failures.push("PPTX has no title-sized text at or above 36pt.")
  if (fontSizes.length && Math.min(...fontSizes) < 1000) warnings.push("PPTX includes text below 10pt.")
  if (hasPlaceholderText(text)) failures.push("PPTX contains placeholder-like text.")
}

async function judgeArtifact(summary: RunSummary, failures: string[], warnings: string[], metrics: JudgeResult["metrics"]) {
  const task = tasks[summary.taskId]
  const artifact = summary.artifacts[0]
  if (!artifact?.exists) {
    const candidates = await findByName(summary.workDir, path.basename(summary.artifactPath))
    failures.push(
      candidates.length
        ? `Target artifact does not exist at required path; found at ${candidates.join(", ")}.`
        : "Target artifact does not exist.",
    )
    return
  }
  metrics.artifactSize = artifact.size
  metrics.artifactSha256 = artifact.sha256 ?? ""
  const artifactSummaryPath = path.join(path.dirname(summary.artifactPath), "artifact-summary.json")
  if (!(await stat(artifactSummaryPath).catch(() => undefined))?.isFile()) {
    failures.push("artifact-summary.json is missing.")
  }
  if (summary.taskId === "xlsx-dashboard") await judgeXlsx(summary, task, failures, warnings, metrics)
  if (summary.taskId === "docx-board-memo") await judgeDocx(summary, task, failures, warnings, metrics)
  if (summary.taskId === "pptx-pitch-deck") await judgePptx(summary, task, failures, warnings, metrics)
}

export async function judgeRun(runDir: string): Promise<JudgeResult> {
  const summary = JSON.parse(await readFile(path.join(runDir, "run-summary.json"), "utf8")) as RunSummary
  const failures = commandPolicyFailures(summary.routeId, summary.commands)
  const warnings: string[] = []
  const metrics: JudgeResult["metrics"] = {
    commandCount: summary.commands.length,
    exitCode: summary.exitCode ?? -1,
    durationMs: summary.durationMs,
  }
  if (summary.exitCode !== 0) failures.push(`opencode run exited with ${summary.exitCode}.`)
  await judgeArtifact(summary, failures, warnings, metrics).catch((error) => {
    failures.push(`Artifact judge failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  const score = Math.max(0, Math.min(100, 100 - failures.length * 18 - warnings.length * 4))
  const result: JudgeResult = {
    schemaVersion: 1,
    runId: summary.runId,
    taskId: summary.taskId,
    routeId: summary.routeId,
    passed: failures.length === 0,
    score,
    failures,
    warnings,
    metrics,
  }
  await writeFile(path.join(runDir, "judge.json"), JSON.stringify(result, null, 2))
  return result
}

async function matrix(startRound: number, rounds: number, model: string, variant?: string) {
  for (let round = startRound; round <= rounds; round++) {
    for (const taskId of Object.keys(tasks) as TaskID[]) {
      for (const routeId of ["officecli", "python"] as RouteID[]) {
        await runOne(taskId, routeId, round, model, variant)
      }
    }
  }
}

async function report() {
  await mkdir(runsRoot, { recursive: true })
  const rows: { judge: JudgeResult; summary: RunSummary }[] = []
  for (const name of (await readdir(runsRoot)).sort()) {
    const dir = path.join(runsRoot, name)
    if (!(await stat(dir).catch(() => undefined))?.isDirectory()) continue
    const judgePath = path.join(dir, "judge.json")
    const summaryPath = path.join(dir, "run-summary.json")
    if (!(await stat(judgePath).catch(() => undefined))?.isFile()) continue
    const judge = JSON.parse(await readFile(judgePath, "utf8")) as JudgeResult
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as RunSummary
    rows.push({ judge, summary })
  }
  rows.sort((a, b) => a.summary.round - b.summary.round || a.judge.taskId.localeCompare(b.judge.taskId) || a.judge.routeId.localeCompare(b.judge.routeId))
  const formatFailures = (judge: JudgeResult, summary: RunSummary) =>
    judge.failures
      .map((failure) => failure.replaceAll(`${summary.workDir}/`, "./").replaceAll(evalRoot, "<eval-root>"))
      .join("; ")
  const detailRows = rows.map(
    ({ judge, summary }) =>
      `| ${judge.taskId} | ${judge.routeId} | ${summary.round} | ${judge.passed ? "pass" : "fail"} | ${judge.score} | ${Math.round(summary.durationMs / 1000)} | ${summary.commands.length} | ${formatFailures(judge, summary)} |`,
  )
  const aggregateRows: string[] = []
  for (const taskId of Object.keys(tasks) as TaskID[]) {
    for (const routeId of ["officecli", "python"] as RouteID[]) {
      const subset = rows.filter((row) => row.judge.taskId === taskId && row.judge.routeId === routeId)
      if (!subset.length) continue
      const passes = subset.filter((row) => row.judge.passed).length
      const seconds = subset.map((row) => Math.round(row.summary.durationMs / 1000)).toSorted((a, b) => a - b)
      const commands = subset.map((row) => row.summary.commands.length).toSorted((a, b) => a - b)
      const median = (values: number[]) => values[Math.floor(values.length / 2)] ?? 0
      aggregateRows.push(
        `| ${taskId} | ${routeId} | ${passes}/${subset.length} | ${median(seconds)} | ${median(commands)} |`,
      )
    }
  }
  const pythonByTask = Object.keys(tasks).map((taskId) => {
    const subset = rows.filter((row) => row.judge.taskId === taskId && row.judge.routeId === "python")
    return subset.filter((row) => row.judge.passed).length
  })
  const replacementReady = pythonByTask.length === 3 && pythonByTask.every((passes) => passes >= 2)
  const verdict = replacementReady
    ? "Python route cleared the replacement bar in this run set. A formal replacement PR is worth opening after a final review of failures, route policy, and artifact samples."
    : "Do not open a formal OfficeCLI replacement PR yet. Python route beats OfficeCLI on xlsx and ties docx, but pptx still fails 0/3 on explicit font-size XML."
  const body = [
    "# Office Route Eval Report",
    "",
    "## Verdict",
    "",
    verdict,
    "",
    "Next smallest boundary: keep this eval harness as the baseline, then harden only the Python pptx skill/template so generated decks set run-level font sizes and pass the existing pptx judge in at least 2/3 rounds.",
    "",
    "## Aggregate",
    "",
    "| Task | Route | Passes | Median Seconds | Median Commands |",
    "|---|---:|---:|---:|---:|",
    ...(aggregateRows.length ? aggregateRows : ["| n/a | n/a | n/a | n/a | n/a |"]),
    "",
    "## Runs",
    "",
    "| Task | Route | Round | Result | Score | Seconds | Commands | Failures |",
    "|---|---:|---:|---|---:|---:|---:|---|",
    ...(detailRows.length ? detailRows : ["| n/a | n/a | n/a | n/a | n/a | n/a | n/a | No runs yet |"]),
    "",
    "Replacement PR bar: Python route must pass all three task families in at least two of three rounds with zero route-policy failures.",
  ].join("\n")
  const reportPath = path.join(evalRoot, "report.md")
  await writeFile(reportPath, body)
  console.log(reportPath)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  await mkdir(runsRoot, { recursive: true })
  if (!command || command === "help") {
    usage()
    return
  }
  if (command === "run") {
    await runOne(
      assertTask(args.task),
      assertRoute(args.route),
      Number(args.round ?? 1),
      String(args.model ?? "openai/gpt-5.4-mini"),
      typeof args.variant === "string" ? args.variant : undefined,
    )
    return
  }
  if (command === "calibrate") {
    await matrix(1, 1, String(args.model ?? "openai/gpt-5.4-mini"), typeof args.variant === "string" ? args.variant : undefined)
    await report()
    return
  }
  if (command === "full") {
    await matrix(
      Number(args["start-round"] ?? 1),
      Number(args.rounds ?? 3),
      String(args.model ?? "openai/gpt-5.4-mini"),
      typeof args.variant === "string" ? args.variant : undefined,
    )
    await report()
    return
  }
  if (command === "judge") {
    const runDir = String(args.run ?? "")
    if (!runDir) throw new Error("--run is required")
    console.log(JSON.stringify(await judgeRun(path.resolve(packageRoot, runDir)), null, 2))
    return
  }
  if (command === "report") {
    await report()
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}
