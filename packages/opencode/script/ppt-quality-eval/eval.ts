import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js"

export type RouteID = "officecli" | "python-pptx" | "pptxgenjs" | "svg-pptx" | "html-showcase"
export type TaskID = "investor-update" | "template-following" | "report-to-deck"

export type CommandAudit = {
  tool: string
  command: string
  description?: string
  status?: string
}

type FixtureSpec = {
  source: string
  target: string
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
  qualityBand: ReturnType<typeof qualityBand>
  failures: string[]
  warnings: string[]
  metrics: Record<string, number | string | boolean>
}

type TaskSpec = {
  id: TaskID
  nativeArtifact: string
  htmlArtifact: string
  expectedSlides: number
  fixtures: FixtureSpec[]
  requiredText: string[]
  requiresChart?: boolean
  requiresImage?: boolean
  prompt: string
}

const evalRoot = import.meta.dir
const packageRoot = path.resolve(evalRoot, "../..")
const repoRoot = path.resolve(packageRoot, "../..")
const runsRoot = path.join(evalRoot, "runs")
const toolsDir = path.join(repoRoot, "packages/desktop-electron/resources/tools")
const officeCliPath = path.join(toolsDir, process.platform === "win32" ? "officecli.exe" : "officecli")
const bundledRuntimeRoot = path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies")
const bundledNodePath = process.env.PPTX_EVAL_NODE ?? path.join(bundledRuntimeRoot, "node/bin/node")
const bundledNodeModules = process.env.PPTX_EVAL_NODE_MODULES ?? path.join(bundledRuntimeRoot, "node/node_modules")
const svgPptxScript = path.join(evalRoot, "route-skills/svg-pptx-native/scripts/svg_to_pptx.py")

const tasks: Record<TaskID, TaskSpec> = {
  "investor-update": {
    id: "investor-update",
    nativeArtifact: "helioops-investor-update.pptx",
    htmlArtifact: "helioops-investor-update.html",
    expectedSlides: 7,
    requiresChart: true,
    fixtures: [
      { source: path.join(evalRoot, "fixtures/investor-update.md"), target: "investor-update.md" },
      { source: path.join(evalRoot, "fixtures/revenue-mix.csv"), target: "revenue-mix.csv" },
    ],
    requiredText: ["HelioOps", "$4.8M", "121%", "$3.5M", "18 months", "ServiceTitan"],
    prompt: [
      "Create a seven-slide investor update deck from ./input/investor-update.md and ./input/revenue-mix.csv.",
      "Use conclusion titles, not generic topic labels.",
      "Include a chart based on revenue-mix.csv.",
      "Include speaker notes on slides 2 through 7 for native PPTX routes.",
      "The deck must make the $3.5M ask and 18-month plan clear.",
    ].join("\n"),
  },
  "template-following": {
    id: "template-following",
    nativeArtifact: "helioops-partner-strategy.pptx",
    htmlArtifact: "helioops-partner-strategy.html",
    expectedSlides: 5,
    fixtures: [
      { source: path.join(evalRoot, "fixtures/template-following-brief.md"), target: "template-following-brief.md" },
      {
        source: path.join(repoRoot, "skills/morph-ppt/reference/styles/light--minimal-product/light__minimal_product.pptx"),
        target: "starter-template.pptx",
      },
    ],
    requiredText: ["HelioOps Partner Strategy", "Partners Matter", "Partner Motion", "90-Day", "ServiceTitan"],
    prompt: [
      "Create a five-slide partner strategy deck from ./input/template-following-brief.md.",
      "Use ./input/starter-template.pptx as the visual source.",
      "Native PPTX routes should preserve editable slide structure and must not flatten the template into a screenshot background.",
      "HTML showcase route should translate the template's restraint into a locked-layout HTML deck.",
    ].join("\n"),
  },
  "report-to-deck": {
    id: "report-to-deck",
    nativeArtifact: "field-service-ai-decision.pptx",
    htmlArtifact: "field-service-ai-decision.html",
    expectedSlides: 6,
    requiresImage: true,
    fixtures: [
      { source: path.join(evalRoot, "fixtures/market-report.md"), target: "market-report.md" },
      { source: path.join(repoRoot, "packages/opencode/test/tool/fixtures/large-image.png"), target: "workflow-screenshot.png" },
    ],
    requiredText: ["Field Service AI", "exception", "8-12 hours", "dispatcher", "VP Operations"],
    prompt: [
      "Create a six-slide decision deck from ./input/market-report.md and ./input/workflow-screenshot.png.",
      "The deck should persuade a VP Operations audience to approve an exception-handling prototype.",
      "Use the image as a screenshot-like evidence object on at least one slide.",
      "Avoid a bullet-only report summary.",
    ].join("\n"),
  },
}

function usage() {
  console.log(`Usage:
  bun run ppt:eval calibrate --model openai/gpt-5.4-mini --variant medium
  bun run ppt:eval full --model openai/gpt-5.4-mini --variant medium --rounds 2
  bun run ppt:eval run --task investor-update --route pptxgenjs --round 1 --model openai/gpt-5.4-mini --variant medium
  bun run ppt:eval judge --run script/ppt-quality-eval/runs/<run-id>
  bun run ppt:eval report`)
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
  if (value === "investor-update" || value === "template-following" || value === "report-to-deck") return value
  throw new Error(`Unknown task: ${String(value)}`)
}

function assertRoute(value: unknown): RouteID {
  if (value === "officecli" || value === "python-pptx" || value === "pptxgenjs" || value === "svg-pptx" || value === "html-showcase") return value
  throw new Error(`Unknown route: ${String(value)}`)
}

function selectedTasks(value: unknown): TaskID[] {
  if (typeof value !== "string") return Object.keys(tasks) as TaskID[]
  return value.split(",").map((item) => assertTask(item.trim()))
}

function selectedRoutes(value: unknown): RouteID[] {
  if (typeof value !== "string") return ["officecli", "python-pptx", "pptxgenjs", "svg-pptx", "html-showcase"]
  return value.split(",").map((item) => assertRoute(item.trim()))
}

function artifactName(task: TaskSpec, route: RouteID) {
  return route === "html-showcase" ? task.htmlArtifact : task.nativeArtifact
}

export function taskGateInstructions(
  task: Pick<TaskSpec, "requiredText" | "requiresChart" | "requiresImage">,
  route: RouteID,
) {
  const lines = [`Required text that must appear verbatim in the final artifact: ${task.requiredText.join(", ")}.`]
  if (task.requiresChart) {
    lines.push(
      route === "html-showcase"
        ? "This is a data-backed task: include a chart-like evidence object such as an SVG, canvas, or explicit chart block."
        : "This is a data-backed native PPTX task: include a real editable chart so the PPTX contains chart XML.",
    )
  }
  if (task.requiresImage) {
    lines.push(
      route === "html-showcase"
        ? "This is an image-evidence task: include the provided image with an <img> element or CSS background-image."
        : "This is an image-evidence native PPTX task: embed the provided image so the final package contains a ppt/media relationship.",
    )
  }
  return lines.join("\n")
}

function routeConfig(route: RouteID) {
  const skillName =
    route === "officecli"
      ? "officecli-current"
      : route === "python-pptx"
        ? "python-pptx-native"
        : route === "pptxgenjs"
          ? "pptxgenjs-native"
          : route === "svg-pptx"
            ? "svg-pptx-native"
            : "html-showcase"
  return {
    skills: {
      paths: [path.join(evalRoot, "route-skills", skillName)],
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

function decodeXml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function textFromXml(xml: string) {
  return [...xml.matchAll(/<(?:[a-zA-Z0-9]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?t>/g)]
    .map((match) => decodeXml(match[1]))
    .join(" ")
}

function countMatches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length
}

function hasPlaceholderText(value: string) {
  return /\{\{|\[必填\]|<TODO>|TODO|lorem|xxxx|\$xxx\$|placeholder/i.test(value)
}

export function htmlFeatureFailures(html: string, needs: { requiresChart?: boolean; requiresImage?: boolean }) {
  const failures: string[] = []
  if (needs.requiresChart && !/(<svg\b|<canvas\b|data-chart=|class=["'][^"']*chart)/i.test(html)) {
    failures.push("HTML deck has no chart-like evidence object for a data-backed task.")
  }
  if (needs.requiresImage && !/(<img\b|background-image\s*:|url\([^)]*\.(?:png|jpe?g|webp|svg))/i.test(html)) {
    failures.push("HTML deck has no image evidence object for the image task.")
  }
  return failures
}

function addRequiredTextFailures(failures: string[], text: string, required: string[]) {
  for (const item of required) {
    if (!text.toLowerCase().includes(item.toLowerCase())) failures.push(`Missing required text: ${item}`)
  }
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

export function qualityBand(score: number) {
  if (score >= 85) return "excellent"
  if (score >= 70) return "usable"
  if (score >= 50) return "weak"
  return "failed"
}

export function scoreFromFindings(failures: string[], warnings: string[]) {
  const raw = Math.max(0, Math.min(100, 100 - failures.length * 12 - warnings.length * 4))
  return failures.length ? Math.min(raw, 84) : raw
}

export function commandPolicyFailures(route: RouteID, commands: CommandAudit[]) {
  const failures: string[] = []
  const joined = commands.map((item) => item.command).join("\n").toLowerCase()
  if (/\b(libreoffice|soffice|lowriter|localc|loffice)\b/.test(joined)) failures.push("Route used LibreOffice or a LibreOffice alias.")
  if (route === "officecli") {
    if (!/\bofficecli\b/.test(joined)) failures.push("OfficeCLI route did not call officecli.")
    if (/\buv\b/.test(joined)) failures.push("OfficeCLI route called uv.")
    if (/\b(pptxgenjs|from pptx|python-pptx|python_pptx)\b/.test(joined)) failures.push("OfficeCLI route appears to use another final PPTX renderer.")
  }
  if (route === "python-pptx") {
    if (!/\buv\b/.test(joined)) failures.push("Python PPTX route did not call uv.")
    if (/\bofficecli\b/.test(joined)) failures.push("Python PPTX route called officecli.")
    if (/\bpptxgenjs\b/.test(joined)) failures.push("Python PPTX route called PptxGenJS.")
  }
  if (route === "pptxgenjs") {
    if (!/\bnode\b|pptx_eval_node/i.test(joined)) failures.push("PptxGenJS route did not call node.")
    if (/\bofficecli\b/.test(joined)) failures.push("PptxGenJS route called officecli.")
    if (/\buv\b|python-pptx|python_pptx|from pptx\b/.test(joined)) failures.push("PptxGenJS route used Python PPTX tooling.")
  }
  if (route === "svg-pptx") {
    if (!/\buv\b/.test(joined)) failures.push("SVG PPTX route did not call uv.")
    if (/\bofficecli\b/.test(joined)) failures.push("SVG PPTX route called officecli.")
    if (/\bpptxgenjs\b/.test(joined)) failures.push("SVG PPTX route called PptxGenJS.")
  }
  if (route === "html-showcase") {
    if (/\bofficecli\b/.test(joined)) failures.push("HTML showcase route called officecli.")
    if (/\b(libreoffice|soffice|lowriter|localc|loffice)\b/.test(joined)) failures.push("HTML showcase route used LibreOffice.")
  }
  return failures
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

function extractFontSizes(slideXml: string) {
  return [...slideXml.matchAll(/<a:(?:rPr|defRPr|endParaRPr)\b[^>]*\bsz="(\d+)"/g)].map((match) => Number(match[1]))
}

function slideNumber(name: string) {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
}

export function countOutOfBoundsShapes(slideXmls: string[]) {
  const maxX = 33.87 * 360000
  const maxY = 19.05 * 360000
  let count = 0
  for (const xml of slideXmls) {
    for (const match of xml.matchAll(/<p:(sp|pic|graphicFrame)(?:\s[^>]*)?>([\s\S]*?)<\/p:\1>/g)) {
      const kind = match[1]
      const body = match[2]
      const geom = body.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/)
      if (!geom) continue
      const x = Number(geom[1])
      const y = Number(geom[2])
      const width = Number(geom[3])
      const height = Number(geom[4])
      if (x >= -2000 && y >= -2000 && x + width <= maxX + 2000 && y + height <= maxY + 2000) continue
      const carriesContent = kind !== "sp" || /<a:t[\s>]/.test(body)
      if (carriesContent) {
        count += 1
        continue
      }
      // Decorative shapes may bleed off the edge by design; fail only when most of the shape is off-canvas.
      const centerX = x + width / 2
      const centerY = y + height / 2
      if (centerX < 0 || centerY < 0 || centerX > maxX || centerY > maxY) count += 1
    }
  }
  return count
}

function slideSignature(xml: string) {
  const shapes = Math.min(9, countMatches(xml, /<p:sp[\s>]/g))
  const pics = Math.min(4, countMatches(xml, /<p:pic[\s>]/g))
  const frames = Math.min(4, countMatches(xml, /<p:graphicFrame[\s>]/g))
  const textRuns = Math.min(9, countMatches(xml, /<a:t[\s>]/g))
  return `${shapes}:${pics}:${frames}:${textRuns}`
}

async function judgeNativePptx(summary: RunSummary, task: TaskSpec, failures: string[], warnings: string[], metrics: JudgeResult["metrics"]) {
  const zip = await readZipEntries(summary.artifactPath)
  const slideEntries = [...zip.entries()]
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(([a], [b]) => slideNumber(a) - slideNumber(b))
  const slideXmls = slideEntries.map(([, value]) => value)
  const slideXml = slideXmls.join("\n")
  const text = textFromXml(slideXml)
  const fontSizes = extractFontSizes(slideXml)
  const notesCount = [...zip.keys()].filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)).length
  const chartCount = [...zip.keys()].filter((name) => name.startsWith("ppt/charts/chart")).length
  const mediaCount = [...zip.keys()].filter((name) => name.startsWith("ppt/media/")).length
  const outOfBounds = countOutOfBoundsShapes(slideXmls)
  const uniqueLayouts = new Set(slideXmls.map(slideSignature)).size
  const visualSlides = slideXmls.filter((xml) => countMatches(xml, /<p:pic[\s>]/g) || countMatches(xml, /<p:graphicFrame[\s>]/g) || countMatches(xml, /<p:sp[\s>]/g) >= 3).length

  metrics.slideCount = slideEntries.length
  metrics.notesCount = notesCount
  metrics.chartCount = chartCount
  metrics.mediaCount = mediaCount
  metrics.explicitFontSizeCount = fontSizes.length
  metrics.maxFontCentipoints = fontSizes.length ? Math.max(...fontSizes) : 0
  metrics.minFontCentipoints = fontSizes.length ? Math.min(...fontSizes) : 0
  metrics.uniqueLayoutSignatures = uniqueLayouts
  metrics.visualSlides = visualSlides
  metrics.outOfBoundsShapes = outOfBounds
  metrics.slideMasterCount = [...zip.keys()].filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name)).length
  metrics.themeCount = [...zip.keys()].filter((name) => /^ppt\/theme\/theme\d+\.xml$/.test(name)).length

  if (!zip.has("[Content_Types].xml") || !zip.has("ppt/presentation.xml")) failures.push("Invalid pptx package structure.")
  if (slideEntries.length !== task.expectedSlides) failures.push(`Expected ${task.expectedSlides} slides, found ${slideEntries.length}.`)
  addRequiredTextFailures(failures, text, task.requiredText)
  if (task.requiresChart && chartCount < 1) failures.push("Native PPTX has no chart XML for a data-backed task.")
  if (task.requiresImage && mediaCount < 1) failures.push("Native PPTX has no media relationship for the image task.")
  if (notesCount < Math.max(1, task.expectedSlides - 1)) failures.push("Native PPTX is missing speaker notes on content slides.")
  if (!fontSizes.length) failures.push("Native PPTX has no explicit run font sizes.")
  if (fontSizes.length && Math.max(...fontSizes) < 3600) failures.push("Native PPTX has no title-sized text at or above 36pt.")
  if (outOfBounds > 0) failures.push(`Native PPTX has ${outOfBounds} out-of-bounds positioned shapes.`)
  if (visualSlides < task.expectedSlides) failures.push("Native PPTX has at least one text-only or under-designed slide.")
  if (hasPlaceholderText(text)) failures.push("Native PPTX contains placeholder-like text.")
  if (fontSizes.length && Math.min(...fontSizes) < 1000) warnings.push("Native PPTX includes text below 10pt.")
  if (uniqueLayouts < Math.min(3, task.expectedSlides)) warnings.push("Native PPTX layout signatures are too repetitive.")
}

async function judgeHtml(summary: RunSummary, task: TaskSpec, failures: string[], warnings: string[], metrics: JudgeResult["metrics"]) {
  const html = await readFile(summary.artifactPath, "utf8")
  const sectionCount = countMatches(html, /<section\b/gi)
  const layoutValues = [...html.matchAll(/data-layout=["']([^"']+)["']/gi)].map((match) => match[1])
  const uniqueLayouts = new Set(layoutValues).size
  const text = html.replace(/<[^>]+>/g, " ")
  metrics.sectionCount = sectionCount
  metrics.dataLayoutCount = layoutValues.length
  metrics.uniqueLayouts = uniqueLayouts
  metrics.hasCssTokens = /--(?:accent|bg|text|space|font)/.test(html)
  metrics.hasViewport = /width=device-width/.test(html)
  if (sectionCount !== task.expectedSlides) failures.push(`Expected ${task.expectedSlides} HTML slides, found ${sectionCount}.`)
  addRequiredTextFailures(failures, text, task.requiredText)
  if (layoutValues.length < sectionCount) failures.push("HTML deck is missing data-layout on one or more slides.")
  if (uniqueLayouts < Math.min(3, task.expectedSlides)) failures.push("HTML deck uses too few distinct locked layouts.")
  if (!metrics.hasCssTokens) failures.push("HTML deck does not define reusable CSS design tokens.")
  failures.push(...htmlFeatureFailures(html, { requiresChart: task.requiresChart, requiresImage: task.requiresImage }))
  if (hasPlaceholderText(text)) failures.push("HTML deck contains placeholder-like text.")
  if (!/<style[\s>]/i.test(html)) warnings.push("HTML deck has no embedded style block.")
  if (!metrics.hasViewport) warnings.push("HTML deck has no responsive viewport metadata.")
}

async function judgeArtifact(summary: RunSummary, failures: string[], warnings: string[], metrics: JudgeResult["metrics"]) {
  const task = tasks[summary.taskId]
  const artifact = summary.artifacts[0]
  if (!artifact?.exists) {
    const candidates = await findByName(summary.workDir, path.basename(summary.artifactPath))
    failures.push(candidates.length ? `Target artifact missing at required path; found at ${candidates.join(", ")}.` : "Target artifact does not exist.")
    return
  }
  metrics.artifactSize = artifact.size
  metrics.artifactSha256 = artifact.sha256 ?? ""
  const artifactSummaryPath = path.join(path.dirname(summary.artifactPath), "artifact-summary.json")
  if (!(await stat(artifactSummaryPath).catch(() => undefined))?.isFile()) failures.push("artifact-summary.json is missing.")
  if (summary.routeId === "html-showcase") await judgeHtml(summary, task, failures, warnings, metrics)
  else await judgeNativePptx(summary, task, failures, warnings, metrics)
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
  for (const fixture of task.fixtures) {
    await copyFile(fixture.source, path.join(inputDir, fixture.target))
  }
  if (route === "python-pptx") {
    await copyFile(path.join(evalRoot, "route-templates/python/pyproject.toml"), path.join(workDir, "pyproject.toml"))
  }
  if (route === "svg-pptx") {
    await copyFile(path.join(evalRoot, "route-templates/svg-pptx/pyproject.toml"), path.join(workDir, "pyproject.toml"))
  }
  return { runId, runDir, workDir }
}

function buildPrompt(task: TaskSpec, route: RouteID, workDir: string) {
  const artifact = path.join(workDir, "artifacts", artifactName(task, route))
  const routeLine =
    route === "officecli"
      ? "Use the current PawWork OfficeCLI route. You must use officecli for the final PPTX artifact."
      : route === "python-pptx"
        ? "Use the Python + uv + python-pptx route. You must use uv and must not call officecli."
        : route === "pptxgenjs"
          ? "Use the PptxGenJS route. Use $PPTX_EVAL_NODE and bundled NODE_PATH; do not call officecli or uv."
          : route === "svg-pptx"
            ? "Use the SVG-to-PPTX route. Author one SVG per slide, then convert with the bundled svg_to_pptx tool via uv as the skill describes. Do not call officecli or PptxGenJS."
            : "Use the HTML showcase route. Create a single HTML deck, not a PPTX."
  return [
    "# PPT quality eval task",
    "",
    routeLine,
    "Do not use LibreOffice, soffice, lowriter, localc, or loffice.",
    "Work only inside the current working directory.",
    "Use the attached source files and the same source paths under ./input/.",
    route === "html-showcase"
      ? "HTML route typography must use a clear type scale and locked CSS tokens."
      : "Native PPTX typography contract: every slide title must be at least 44pt, body text at least 18pt, and title size at least 2x body size.",
    taskGateInstructions(task, route),
    "",
    task.prompt,
    "",
    `Write the final artifact to: ${artifact}`,
    "",
    "After creating the artifact, write ./artifacts/artifact-summary.json with:",
    JSON.stringify(
      {
        artifact,
        route,
        task: task.id,
        renderer: "name and version if known",
        slideTitles: ["ordered slide titles"],
        layoutNames: ["ordered layout names"],
        visualRulesApplied: ["short list"],
        commandsUsed: ["short list of important commands"],
        limitations: [],
      },
      null,
      2,
    ),
    "",
    "Do not claim success unless the target artifact exists at the exact path.",
    `Write only under this working directory: ${workDir}`,
  ].join("\n")
}

async function runOne(taskId: TaskID, routeId: RouteID, round: number, model: string, variant?: string) {
  const task = tasks[taskId]
  const { runId, runDir, workDir } = await prepareRunDir(task, routeId, round)
  const startedAt = new Date()
  const prompt = buildPrompt(task, routeId, workDir)
  await writeFile(path.join(runDir, "prompt.md"), prompt)

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
    ...task.fixtures.flatMap((fixture) => ["--file", path.join(workDir, "input", fixture.target)]),
  ]
  if (variant) args.push("--variant", variant)
  args.push(prompt)

  const routePath =
    routeId === "officecli"
      ? `${toolsDir}${path.delimiter}${process.env.PATH ?? ""}`
      : routeId === "pptxgenjs"
        ? `${path.dirname(bundledNodePath)}${path.delimiter}${process.env.PATH ?? ""}`
        : process.env.PATH ?? ""
  const env = {
    ...process.env,
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(routeConfig(routeId)),
    OFFICECLI_SKIP_UPDATE: "1",
    PPTX_EVAL_NODE: bundledNodePath,
    SVG_PPTX_SCRIPT: svgPptxScript,
    NODE_PATH: `${bundledNodeModules}${process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : ""}`,
    PATH: routePath,
  }

  const proc = Bun.spawn(["bun", ...args], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeoutMs = Number(process.env.PPT_QUALITY_EVAL_TIMEOUT_MS ?? 10 * 60 * 1000)
  const killer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(killer))

  await writeFile(path.join(runDir, "events.jsonl"), stdout)
  await writeFile(path.join(runDir, "stderr.log"), stderr)
  const { commands, eventCounts } = extractCommandsFromJsonl(stdout)
  const artifactPath = path.join(workDir, "artifacts", artifactName(task, routeId))
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
    commands,
    artifacts: await artifactSummaries(artifactPath),
    eventCounts,
  }
  await writeFile(path.join(runDir, "run-summary.json"), JSON.stringify(summary, null, 2))
  const judge = await judgeRun(runDir)
  console.log(`${judge.passed ? "PASS" : "FAIL"} ${runId} score=${judge.score} band=${judge.qualityBand}`)
  if (judge.failures.length) console.log(judge.failures.map((item) => `  - ${item}`).join("\n"))
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
  const score = scoreFromFindings(failures, warnings)
  const result: JudgeResult = {
    schemaVersion: 1,
    runId: summary.runId,
    taskId: summary.taskId,
    routeId: summary.routeId,
    passed: failures.length === 0,
    score,
    qualityBand: qualityBand(score),
    failures,
    warnings,
    metrics,
  }
  await writeFile(path.join(runDir, "judge.json"), JSON.stringify(result, null, 2))
  return result
}

async function matrix(startRound: number, rounds: number, model: string, variant: string | undefined, taskIds: TaskID[], routeIds: RouteID[]) {
  for (let round = startRound; round <= rounds; round++) {
    for (const taskId of taskIds) {
      for (const routeId of routeIds) {
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
    rows.push({
      judge: JSON.parse(await readFile(judgePath, "utf8")) as JudgeResult,
      summary: JSON.parse(await readFile(summaryPath, "utf8")) as RunSummary,
    })
  }
  rows.sort((a, b) => a.summary.round - b.summary.round || a.judge.taskId.localeCompare(b.judge.taskId) || a.judge.routeId.localeCompare(b.judge.routeId))
  const aggregateRows: string[] = []
  for (const routeId of ["officecli", "python-pptx", "pptxgenjs", "svg-pptx", "html-showcase"] as RouteID[]) {
    const subset = rows.filter((row) => row.judge.routeId === routeId)
    if (!subset.length) continue
    const passes = subset.filter((row) => row.judge.passed).length
    const medianScore = subset.map((row) => row.judge.score).toSorted((a, b) => a - b)[Math.floor(subset.length / 2)] ?? 0
    aggregateRows.push(`| ${routeId} | ${passes}/${subset.length} | ${medianScore} | ${qualityBand(medianScore)} |`)
  }
  const detailRows = rows.map(({ judge, summary }) => {
    const failures = judge.failures.map((failure) => failure.replaceAll(`${summary.workDir}/`, "./")).join("; ")
    return `| ${judge.taskId} | ${judge.routeId} | ${summary.round} | ${judge.passed ? "pass" : "fail"} | ${judge.score} | ${judge.qualityBand} | ${Math.round(summary.durationMs / 1000)} | ${summary.commands.length} | ${failures} |`
  })
  const nativeRows = rows.filter((row) => row.judge.routeId !== "html-showcase")
  const htmlRows = rows.filter((row) => row.judge.routeId === "html-showcase")
  const body = [
    "# PPT Quality Eval Report",
    "",
    "## Scope Note",
    "",
    "Native PPTX and HTML showcase are intentionally scored separately. HTML quality can prove layout discipline, but it cannot prove editable PowerPoint fidelity.",
    "",
    "## Aggregate",
    "",
    "| Route | Passes | Median Score | Median Band |",
    "|---|---:|---:|---|",
    ...(aggregateRows.length ? aggregateRows : ["| n/a | n/a | n/a | n/a |"]),
    "",
    "## Native PPTX Verdict",
    "",
    nativeRows.length
      ? "Native verdict should be based on PPTX structure gates: editability, notes, chart/media XML, explicit run font sizes, and bounds checks."
      : "No native PPTX runs yet.",
    "",
    "## HTML Showcase Verdict",
    "",
    htmlRows.length
      ? "HTML verdict should be based on locked layouts, CSS tokens, section count, and visual-system discipline. It is not a native PPTX replacement signal."
      : "No HTML showcase runs yet.",
    "",
    "## Runs",
    "",
    "| Task | Route | Round | Result | Score | Band | Seconds | Commands | Failures |",
    "|---|---|---:|---|---:|---|---:|---:|---|",
    ...(detailRows.length ? detailRows : ["| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No runs yet |"]),
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
    await matrix(1, 1, String(args.model ?? "openai/gpt-5.4-mini"), typeof args.variant === "string" ? args.variant : undefined, selectedTasks(args.tasks), selectedRoutes(args.routes))
    await report()
    return
  }
  if (command === "full") {
    await matrix(
      Number(args["start-round"] ?? 1),
      Number(args.rounds ?? 2),
      String(args.model ?? "openai/gpt-5.4-mini"),
      typeof args.variant === "string" ? args.variant : undefined,
      selectedTasks(args.tasks),
      selectedRoutes(args.routes),
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
