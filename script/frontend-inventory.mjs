#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const FRONTEND_PATHS = [
  "packages/app/src/**/*.ts",
  "packages/app/src/**/*.tsx",
  "packages/ui/src/**/*.ts",
  "packages/ui/src/**/*.tsx",
]
const FRONTEND_PATHSPECS = FRONTEND_PATHS.map((path) => `:(glob)${path}`)

const OWNER_LANES = [
  {
    lane: "#595/#615 scroll-perf",
    issue: "https://github.com/Astro-Han/pawwork/issues/595",
    reason: "scroll, perf probes, timeline position ownership, or long-session responsiveness",
    patterns: [
      /scroll/i,
      /virtual/i,
      /perf/i,
      /performance/i,
      /timeline-scroll/i,
      /create-auto-scroll/i,
      /use-session-hash-scroll/i,
    ],
  },
  {
    lane: "#601 message flow",
    issue: "https://github.com/Astro-Han/pawwork/issues/601",
    reason: "session timeline, turn shell, message shell, markdown, tool rows, or message-flow state",
    patterns: [
      /message/i,
      /timeline/i,
      /session-turn/i,
      /markdown/i,
      /reasoning/i,
      /tool-call/i,
      /attachment/i,
      /session-status/i,
      /use-session-commands/i,
      /use-session-timeline/i,
      /^packages\/app\/src\/pages\/session\.tsx$/,
    ],
  },
  {
    lane: "#604 settings",
    issue: "https://github.com/Astro-Han/pawwork/issues/604",
    reason: "settings page, provider dialogs, settings context, or settings-owned permission surface",
    patterns: [
      /settings/i,
      /dialog-connect-provider/i,
      /dialog-select-server/i,
      /dialog-select-provider/i,
      /dialog-custom-provider/i,
      /dialog-connect-websearch/i,
      /provider/i,
      /permission/i,
    ],
  },
  {
    lane: "#638 interface audit",
    issue: "https://github.com/Astro-Han/pawwork/issues/638",
    reason: "public exports, package contract, shared type/interface, schema, event name, or tool-name boundary",
    patterns: [
      /types?\.ts$/,
      /interface/i,
      /contract/i,
      /schema/i,
      /event-reducer/i,
      /tool-name/i,
      /event-name/i,
      /index\.ts$/,
      /desktop-api/i,
      /session-status-extractors/i,
    ],
  },
  {
    lane: "#605 visual shell",
    issue: "https://github.com/Astro-Han/pawwork/issues/605",
    reason: "shared visual primitives, theme, typography, token, style, motion, or reusable UI package surface",
    patterns: [
      /^packages\/ui\/src\//,
      /theme/i,
      /token/i,
      /typography/i,
      /visual/i,
      /style/i,
      /animation/i,
      /line-comment/i,
      /status-popover/i,
    ],
  },
  {
    lane: "#606 final shell",
    issue: "https://github.com/Astro-Han/pawwork/issues/606",
    reason: "layout, global shell, final assembly, shared app context, or cross-area shell cleanup",
    patterns: [
      /layout/i,
      /shell/i,
      /app\.tsx$/,
      /router/i,
      /context\/layout/i,
      /context\/global/i,
      /context\/local/i,
      /context\/sync/i,
      /context\/terminal/i,
      /context\/platform/i,
      /context\/command/i,
      /context\/notification/i,
    ],
  },
  {
    lane: "#599 mainline",
    issue: "https://github.com/Astro-Han/pawwork/issues/599",
    reason: "launch path, home/onboarding entry, or UI rewrite integration owner",
    patterns: [/home/i, /onboarding/i, /welcome/i, /session-list/i, /launch/i, /project/i],
  },
]

const CLOSED_AREA_HINTS = [
  {
    issue: "https://github.com/Astro-Han/pawwork/issues/602",
    reason: "matches closed right-panel Area B; needs current owner before new implementation",
    patterns: [
      /terminal/i,
      /session-review/i,
      /session-side-panel/i,
      /file-tree/i,
      /file-tabs/i,
      /context\/file/i,
      /components\/file/i,
    ],
  },
  {
    issue: "https://github.com/Astro-Han/pawwork/issues/603",
    reason: "matches closed home Area C; needs current owner before new implementation",
    patterns: [/home/i],
  },
]

function parseArgs(argv) {
  const out = {
    base: null,
    checkBaseline: false,
    format: "summary",
    head: "HEAD",
    maxRows: 80,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--check-baseline") {
      out.checkBaseline = true
      continue
    }
    if (arg === "--base" || arg === "--base-ref") {
      out.base = argv[index + 1] ?? out.base
      index += 1
      continue
    }
    if (arg === "--head" || arg === "--head-ref") {
      out.head = argv[index + 1] ?? out.head
      index += 1
      continue
    }
    if (arg === "--format") {
      out.format = argv[index + 1] ?? out.format
      index += 1
      continue
    }
    if (arg === "--json") out.format = "json"
    if (arg === "--markdown") out.format = "markdown"
    if (arg === "--max-rows") {
      const maxRows = Number(argv[index + 1] ?? out.maxRows)
      if (Number.isFinite(maxRows) && maxRows >= 0) out.maxRows = maxRows
      index += 1
    }
  }

  return out
}

function physicalLoc(content) {
  if (content.length === 0) return 0
  const newlineCount = content.match(/\n/g)?.length ?? 0
  return newlineCount + (content.endsWith("\n") ? 0 : 1)
}

function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(stripLineComment)
    .join("\n")
    .trim()
}

function stripLineComment(line) {
  let quote = null
  let escaped = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]

    if (escaped) {
      escaped = false
      continue
    }
    if (quote && char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "/" && next === "/") return line.slice(0, index).trimEnd()
  }

  return line
}

function isFacade(path, content) {
  const stripped = stripComments(content)
  if (!stripped) return false

  const statements = moduleStatements(stripped)
  return statements.length > 0 && statements.every(isFacadeStatement)
}

function moduleStatements(content) {
  const statements = []
  let current = ""

  for (const line of content.split(/\n/).map((item) => item.trim()).filter(Boolean)) {
    current = current ? `${current} ${line}` : line
    if (isCompleteModuleStatement(current)) {
      statements.push(current)
      current = ""
    }
  }

  return current ? [] : statements
}

function isCompleteModuleStatement(statement) {
  if (!/^(import|export)\b/.test(statement)) return false
  return (
    /\bfrom\s+["'][^"']+["'];?$/.test(statement) ||
    /^export\s+(type\s+)?\{[\s\S]*\};?$/.test(statement)
  )
}

function isFacadeStatement(statement) {
  return (
    /^export\s+(type\s+)?\{[\s\S]*\}\s+from\s+["'][^"']+["'];?$/.test(statement) ||
    /^export\s+\*\s+from\s+["'][^"']+["'];?$/.test(statement) ||
    /^export\s+(type\s+)?\{[\s\S]*\};?$/.test(statement) ||
    /^import\s+type\s+[\s\S]+\s+from\s+["'][^"']+["'];?$/.test(statement) ||
    /^import\s+(?!["'])[\s\S]+\s+from\s+["'][^"']+["'];?$/.test(statement)
  )
}

function isGeneratedOrStatic(path, content) {
  const head = content.slice(0, 400).toLowerCase()
  return (
    /generated/.test(head) ||
    /(^|\/)(generated|gen|fixtures?|mocks?|assets)(\/|$)/.test(path) ||
    /\.gen\.|\.generated\./.test(path) ||
    /\/(app-icons|file-icons|provider-icons)\/types\.ts$/.test(path)
  )
}

function isPureConfig(path, content) {
  const stripped = stripComments(content)
  if (!stripped) return false
  if (/<[A-Z_a-z]/.test(stripped)) return false
  if (/\b(createSignal|createMemo|createEffect|onMount|onCleanup|function\b)|=>/.test(stripped)) return false
  if (/\.config\.ts$/.test(path)) return true
  if (/(^|\/)constants\//.test(path)) return true

  const lines = stripped.split(/\n/).map((line) => line.trim()).filter(Boolean)
  return lines.length > 0 && lines.every((line) => {
    return (
      isBoundImportStatement(line) ||
      line.startsWith("export const ") ||
      line.startsWith("export type ") ||
      line.startsWith("export interface ") ||
      /^[\]}),;]+$/.test(line) ||
      /^["'`A-Za-z0-9_$-]+:/.test(line) ||
      /^["'`].*[,;]?$/.test(line) ||
      /^[A-Z0-9_$]+[,;]?$/.test(line)
    )
  })
}

function isBoundImportStatement(line) {
  return /^import\s+(?!["'])/.test(line)
}

function classify(path, content) {
  const classifications = []
  const reasons = []

  if (/(^|\/)(__tests__|__mocks__|test|tests|e2e)(\/|$)|\.(test|spec)\./.test(path)) {
    classifications.push("test")
    reasons.push("test/spec path or filename")
  }
  if (/\.stories\./.test(path) || /(^|\/)stories(\/|$)|storybook/.test(path)) {
    classifications.push("story")
    reasons.push("storybook file")
  }
  if (/(^|\/)(i18n|locales?|translations?|dictionary|dictionaries)(\/|$)/.test(path)) {
    classifications.push("i18n")
    reasons.push("i18n dictionary")
  }
  if (isGeneratedOrStatic(path, content)) {
    classifications.push("generated-static")
    reasons.push("generated or static map/asset")
  }
  if (isPureConfig(path, content)) {
    classifications.push("pure-config")
    reasons.push("pure config or constants table")
  }
  if (isFacade(path, content)) {
    classifications.push("facade")
    reasons.push("public facade/barrel")
  }
  if (/(left-sidebar|sidebar|composer|dock|input-bar|prompt-input)/.test(path)) {
    classifications.push("delivered-surface")
    reasons.push("already-delivered left-sidebar/composer/dock/input surface")
  }

  if (classifications.length > 0) {
    return {
      setType: "visibility-only inventory",
      classifications,
      classificationReason: reasons.join("; "),
    }
  }

  return {
    setType: "production ratchet set",
    classifications: ["production"],
    classificationReason: "hand-written production frontend file",
  }
}

function ownerFor(path) {
  for (const owner of OWNER_LANES) {
    if (owner.patterns.some((pattern) => pattern.test(path))) return owner
  }

  const closedHint = CLOSED_AREA_HINTS.find((hint) => hint.patterns.some((pattern) => pattern.test(path)))
  if (closedHint) {
    return {
      lane: "other/deferred",
      issue: closedHint.issue,
      reason: closedHint.reason,
    }
  }

  return {
    lane: "other/deferred",
    issue: null,
    reason: "no active owner lane matched; needs live issue link before implementation",
  }
}

function statusFor(record) {
  if (record.setType === "visibility-only inventory") {
    return {
      status: "inventory-only",
      reason: "visible for future agents but outside default production ratchet",
    }
  }

  if (record.loc > 500) {
    return {
      status: "needs-over-500-resolution",
      reason: ">500 production file; must be resolved or documented as an approved exception",
    }
  }

  if (record.loc > 200) {
    return {
      status: "needs-owner-manifest-entry",
      reason: ">200 production file; must keep owner lane, responsibility explanation, or approved exception",
    }
  }

  if (record.ownerLane === "other/deferred") {
    return {
      status: "needs-live-owner-issue",
      reason: "production file has no active owner lane match",
    }
  }

  return {
    status: "within-ratchet",
    reason: "production file is within current warn-only threshold",
  }
}

function listFrontendFiles() {
  let stdout = ""
  try {
    stdout = execFileSync("git", ["ls-files", ...FRONTEND_PATHSPECS], { encoding: "utf8" }).trim()
  } catch (error) {
    exitWithInventoryError("git ls-files failed; run this command from a PawWork git checkout.", error)
  }
  return stdout ? stdout.split("\n").filter(Boolean).sort() : []
}

function listChangedFrontendFiles(base, head) {
  if (!base || /^0{40}$/.test(base)) {
    return {
      changedPaths: [],
      skippedReason: "No comparable base ref was provided; inventory generated without touched-file warnings.",
    }
  }

  let stdout = ""
  try {
    stdout = execFileSync(
      "git",
      ["diff", "--name-status", "--find-renames", "--find-copies", base, head, "--", ...FRONTEND_PATHSPECS],
      { encoding: "utf8" },
    ).trim()
  } catch (error) {
    exitWithInventoryError(`git diff failed for frontend inventory baseline check (${base}..${head}).`, error)
  }

  const changedPaths = new Set()
  for (const line of stdout ? stdout.split("\n") : []) {
    const [status, path1, path2] = line.split("\t")
    if (!status || status.startsWith("D")) continue
    changedPaths.add(status.startsWith("R") || status.startsWith("C") ? path2 : path1)
  }

  return {
    changedPaths: [...changedPaths].filter(Boolean).sort(),
    skippedReason: null,
  }
}

function readFrontendFile(path) {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    exitWithInventoryError(`failed to read tracked frontend file: ${path}`, error)
  }
}

function githubWarning(record, threshold) {
  const title = encodeURIComponent("Frontend LOC ratchet")
  return `::warning file=${record.path},title=${title}::${record.path} is ${record.loc} LOC (${threshold}); warn-only for #688 LOC ratchet. Keep an owner lane or split before promoting this gate.`
}

function checkBaseline(inventory, { base, head }) {
  const { changedPaths, skippedReason } = listChangedFrontendFiles(base, head)
  const recordsByPath = new Map(inventory.records.map((record) => [record.path, record]))
  const touchedProduction = changedPaths
    .map((path) => recordsByPath.get(path))
    .filter((record) => record?.setType === "production ratchet set")
  const over500 = touchedProduction.filter((record) => record.loc > 500)
  const over200 = touchedProduction.filter((record) => record.loc > 200)
  const warnRows = touchedProduction
    .filter((record) => record.loc > 200)
    .sort((a, b) => b.loc - a.loc)

  console.log("Frontend LOC ratchet warnings")
  console.log("Mode: warn-only")
  console.log(`Base: ${base ?? "(not provided)"}`)
  console.log(`Head: ${head}`)
  console.log(`Changed frontend files: ${changedPaths.length}`)
  console.log(`Touched production files: ${touchedProduction.length}`)
  console.log(`Touched production files >500 LOC: ${over500.length}`)
  console.log(`Touched production files >200 LOC: ${over200.length}`)

  if (skippedReason) {
    console.log(skippedReason)
    return
  }

  for (const record of warnRows) {
    const threshold = record.loc > 500 ? ">500 LOC" : ">200 LOC"
    console.error(githubWarning(record, threshold))
  }
}

function exitWithInventoryError(message, error) {
  console.error(`error: ${message}`)
  if (error instanceof Error && error.message) console.error(error.message)
  process.exit(1)
}

function buildInventory() {
  const files = listFrontendFiles()
  const records = files.map((path) => {
    const content = readFrontendFile(path)
    const classification = classify(path, content)
    const owner = ownerFor(path)
    const record = {
      path,
      loc: physicalLoc(content),
      setType: classification.setType,
      classifications: classification.classifications,
      ownerLane: owner.lane,
      ownerIssue: owner.issue,
      approvedException: null,
      classificationReason: classification.classificationReason,
      ownerReason: owner.reason,
    }
    return {
      ...record,
      ...statusFor(record),
    }
  })

  const summary = {
    schemaVersion: 1,
    command: "node script/frontend-inventory.mjs --format json",
    locMetric: "physical LOC including blank lines and comments",
    paths: FRONTEND_PATHS,
    totalTrackedTsTsx: records.length,
    production: records.filter((record) => record.setType === "production ratchet set").length,
    visibilityOnly: records.filter((record) => record.setType === "visibility-only inventory").length,
    approvedExceptions: records.filter((record) => record.approvedException).length,
    productionOver500: records.filter(
      (record) => record.setType === "production ratchet set" && record.loc > 500,
    ).length,
    productionOver200: records.filter(
      (record) => record.setType === "production ratchet set" && record.loc > 200,
    ).length,
    visibilityOver500: records.filter(
      (record) => record.setType === "visibility-only inventory" && record.loc > 500,
    ).length,
    visibilityOver200: records.filter(
      (record) => record.setType === "visibility-only inventory" && record.loc > 200,
    ).length,
  }

  const byOwnerLane = {}
  for (const record of records.filter((item) => item.setType === "production ratchet set")) {
    byOwnerLane[record.ownerLane] ??= { total: 0, over200: 0, over500: 0 }
    byOwnerLane[record.ownerLane].total += 1
    if (record.loc > 200) byOwnerLane[record.ownerLane].over200 += 1
    if (record.loc > 500) byOwnerLane[record.ownerLane].over500 += 1
  }

  return {
    summary,
    byOwnerLane,
    records,
  }
}

function printSummary(inventory) {
  console.log("Frontend inventory baseline")
  console.log(`Schema: ${inventory.summary.schemaVersion}`)
  console.log(`Command: ${inventory.summary.command}`)
  console.log(`LOC: ${inventory.summary.locMetric}`)
  console.log("")
  for (const [key, value] of Object.entries(inventory.summary)) {
    if (["schemaVersion", "command", "locMetric", "paths"].includes(key)) continue
    console.log(`${key}: ${value}`)
  }
  console.log("")
  console.log("Production by owner lane:")
  for (const [owner, counts] of Object.entries(inventory.byOwnerLane)) {
    console.log(`- ${owner}: ${counts.total} files, ${counts.over200} over 200, ${counts.over500} over 500`)
  }

  const over500 = inventory.records
    .filter((record) => record.setType === "production ratchet set" && record.loc > 500)
    .sort((a, b) => b.loc - a.loc)
  if (over500.length > 0) {
    console.error("")
    console.error(`warn: ${over500.length} production files are over 500 LOC; this script is warn-only.`)
  }
}

function printMarkdown(inventory, maxRows) {
  console.log("| LOC | Owner Lane | Status | Path | Reason |")
  console.log("| ---: | --- | --- | --- | --- |")
  const rows = inventory.records
    .filter((record) => record.setType === "production ratchet set" && record.loc > 200)
    .sort((a, b) => b.loc - a.loc)
    .slice(0, maxRows)
  for (const record of rows) {
    console.log(
      `| ${record.loc} | ${record.ownerLane} | ${record.status} | \`${record.path}\` | ${record.ownerReason} |`,
    )
  }
}

const args = parseArgs(process.argv.slice(2))
const inventory = buildInventory()

if (args.checkBaseline) {
  checkBaseline(inventory, args)
} else if (args.format === "json") {
  console.log(JSON.stringify(inventory, null, 2))
} else if (args.format === "markdown") {
  printMarkdown(inventory, args.maxRows)
} else {
  printSummary(inventory)
}
