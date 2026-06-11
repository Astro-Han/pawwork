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
  args: OpenCliManifestEntry["args"]
}

export type OpenCliAdapterImportFailure = {
  modulePath: string
  error: string
}

export const BLOCKED_OPENCLI_COMMANDS = new Set(["instagram/reel"])

let loadPromise: Promise<{
  manifestCount: number
  canonicalCommands: ReadonlySet<string>
  exposedCommands: ReadonlySet<string>
  failedModules: OpenCliAdapterImportFailure[]
}> | undefined
let manifestCache: OpenCliManifestEntry[] | undefined

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

async function importAdapterModules(
  manifest: OpenCliManifestEntry[],
  options: {
    root?: string
    importModule?: (specifier: string) => Promise<unknown>
  } = {},
) {
  const root = options.root ?? openCliPackageRoot()
  const importModule = options.importModule ?? ((specifier: string) => import(specifier))
  const uniqueModules = new Set(manifest.map((entry) => entry.modulePath))
  const failedModules: OpenCliAdapterImportFailure[] = []
  for (const modulePath of uniqueModules) {
    try {
      await importModule(pathToFileURL(path.join(root, "clis", modulePath)).href)
    } catch (err) {
      failedModules.push({ modulePath, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return failedModules
}

function canonicalCommandSet(): Set<string> {
  return new Set([...getRegistry().values()].map((cmd) => fullName(cmd)))
}

export async function loadOpenCliAdapters() {
  loadPromise ??= (async () => {
    const manifest = await loadManifest()
    const failedModules = await importAdapterModules(manifest)
    const canonicalCommands = canonicalCommandSet()
    const exposedCommands = new Set([...canonicalCommands].filter((name) => !BLOCKED_OPENCLI_COMMANDS.has(name)))
    return {
      manifestCount: manifest.length,
      canonicalCommands,
      exposedCommands,
      failedModules,
    }
  })()
  return loadPromise
}

export const importOpenCliAdapterModulesForTest = importAdapterModules

export async function openCliCommand(name: string): Promise<CliCommand | undefined> {
  await loadOpenCliAdapters()
  if (BLOCKED_OPENCLI_COMMANDS.has(name)) return undefined
  return getRegistry().get(name)
}

function scoreCommand(command: CliCommand, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return 1
  const name = fullName(command).toLowerCase()
  const haystack = [name, command.description, command.domain, command.access, command.browser !== false ? "browser" : "http"]
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
  await loadOpenCliAdapters()
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 25)
  return [...getRegistry().values()]
    .filter((command, index, all) => all.findIndex((other) => fullName(other) === fullName(command)) === index)
    .filter((command) => !BLOCKED_OPENCLI_COMMANDS.has(fullName(command)))
    .map((command) => ({ command, score: scoreCommand(command, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || fullName(a.command).localeCompare(fullName(b.command)))
    .slice(0, limit)
    .map(({ command }) => ({
      name: fullName(command),
      description: command.description ?? "",
      access: command.access,
      browser: command.browser !== false,
      domain: command.domain,
      args: command.args,
    }))
}

export function resetOpenCliAdaptersForTest() {
  loadPromise = undefined
  manifestCache = undefined
}

export * as AdapterRegistry from "./adapter-registry"
