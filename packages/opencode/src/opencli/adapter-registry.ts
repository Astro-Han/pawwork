import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { fullName, getRegistry, type CliCommand } from "@jackwener/opencli/registry"

export type OpenCliManifestEntry = {
  site: string
  name: string
  description?: string
  access: "read" | "write"
  domain?: string
  browser?: boolean
  navigateBefore?: string | boolean
  args?: Array<{
    name: string
    type?: string
    required?: boolean
    default?: unknown
    help?: string
    choices?: string[]
    positional?: boolean
  }>
  type: "js"
  modulePath: string
}

export type OpenCliCommandSummary = {
  name: string
  description: string
  access: "read" | "write"
  browser: boolean
  domain?: string
  navigateBefore?: string | boolean
  args: OpenCliManifestEntry["args"]
}

export const BLOCKED_OPENCLI_COMMANDS = new Set(["instagram/reel"])

let manifestCache: OpenCliManifestEntry[] | undefined
const importedModules = new Set<string>()

function openCliPackageRoot() {
  const cdp = fileURLToPath(import.meta.resolve("@jackwener/opencli/browser/cdp"))
  for (let dir = path.dirname(cdp); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "cli-manifest.json")) && existsSync(path.join(dir, "clis"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
  }
  throw new Error(`Unable to locate @jackwener/opencli package root from ${cdp}`)
}

async function loadManifest(): Promise<OpenCliManifestEntry[]> {
  if (manifestCache) return manifestCache
  const manifestPath = path.join(openCliPackageRoot(), "cli-manifest.json")
  const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as OpenCliManifestEntry[]
  manifestCache = parsed.filter((entry) => entry.type === "js" && typeof entry.modulePath === "string")
  return manifestCache
}

function manifestCommandName(entry: Pick<OpenCliManifestEntry, "site" | "name">) {
  return `${entry.site}/${entry.name}`
}

function manifestCommandSummary(entry: OpenCliManifestEntry): OpenCliCommandSummary {
  return {
    name: manifestCommandName(entry),
    description: entry.description ?? "",
    access: entry.access,
    browser: entry.browser !== false,
    domain: entry.domain,
    navigateBefore: entry.navigateBefore,
    args: entry.args,
  }
}

export function openCliCommandSummaryFromCommand(command: CliCommand): OpenCliCommandSummary {
  return {
    name: fullName(command),
    description: command.description ?? "",
    access: command.access,
    browser: command.browser !== false,
    domain: command.domain,
    navigateBefore: command.navigateBefore,
    args: command.args,
  }
}

async function importAdapterModule(modulePath: string) {
  if (importedModules.has(modulePath)) return
  try {
    await import(pathToFileURL(path.join(openCliPackageRoot(), "clis", modulePath)).href)
    importedModules.add(modulePath)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to load OpenCLI adapter module ${modulePath}: ${message}`)
  }
}

async function manifestEntryForCommand(name: string) {
  return (await loadManifest()).find((entry) => manifestCommandName(entry) === name)
}

export async function openCliCommand(name: string): Promise<CliCommand | undefined> {
  if (BLOCKED_OPENCLI_COMMANDS.has(name)) return undefined
  const existing = getRegistry().get(name)
  if (existing) return existing
  const entry = await manifestEntryForCommand(name)
  if (!entry) return undefined
  await importAdapterModule(entry.modulePath)
  return getRegistry().get(name)
}

function scoreCommand(command: OpenCliCommandSummary, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return 1
  const name = command.name.toLowerCase()
  const haystack = [name, command.description, command.domain, command.access, command.browser ? "browser" : "http"]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  if (name === needle) return 100
  if (name.includes(needle)) return 80
  const terms = needle.split(/\s+/).filter(Boolean)
  const hits = terms.filter((term) => haystack.includes(term)).length
  return hits === 0 ? 0 : hits * 10
}

export async function searchOpenCliCommands(
  query: string,
  options: { limit?: number } = {},
): Promise<OpenCliCommandSummary[]> {
  const manifest = await loadManifest()
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 25)
  const summaries = new Map<string, OpenCliCommandSummary>()
  for (const entry of manifest) {
    const summary = manifestCommandSummary(entry)
    summaries.set(summary.name, summary)
  }
  for (const command of getRegistry().values()) {
    const summary = openCliCommandSummaryFromCommand(command)
    if (!summaries.has(summary.name)) summaries.set(summary.name, summary)
  }
  return [...summaries.values()]
    .filter((command) => !BLOCKED_OPENCLI_COMMANDS.has(command.name))
    .map((command) => ({ command, score: scoreCommand(command, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name))
    .slice(0, limit)
    .map(({ command }) => command)
}

export function resetOpenCliAdaptersForTest() {
  manifestCache = undefined
  importedModules.clear()
}

export * as AdapterRegistry from "./adapter-registry"
