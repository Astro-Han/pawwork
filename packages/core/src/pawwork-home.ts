import path from "path"
import fs from "fs/promises"
import fsNode from "fs"
import { Flag } from "./flag/flag"
import { Global } from "./global"

function resolveHome(input: string) {
  const expanded =
    input === "~" || input === "~\\"
      ? Global.Path.home
      : input.startsWith("~/") || input.startsWith("~\\")
        ? path.join(Global.Path.home, input.slice(2))
        : input
  return path.resolve(expanded)
}

function unique(items: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const key = normalize(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function envPath(input: string | undefined) {
  const value = input?.trim()
  return value ? value : undefined
}

function realpathOrResolved(input: string) {
  const resolved = path.resolve(input)
  try {
    return fsNode.realpathSync.native(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return process.platform === "win32" ? resolved.toLowerCase() : resolved
    throw error
  }
}

function normalize(input: string) {
  return realpathOrResolved(input)
}

function isFile(input: string) {
  try {
    return fsNode.statSync(input).isFile()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    throw error
  }
}

function isDirectory(input: string) {
  try {
    return fsNode.statSync(input).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    throw error
  }
}

export namespace PawWorkHome {
  export function primary() {
    return resolveHome(envPath(Flag.PAWWORK_HOME) ?? envPath(Flag.PAWWORK_CONFIG_DIR) ?? path.join(Global.Path.home, ".pawwork"))
  }

  export function candidates() {
    const home = envPath(Flag.PAWWORK_HOME)
    const config = envPath(Flag.PAWWORK_CONFIG_DIR)
    return unique([
      ...(home ? [resolveHome(home)] : []),
      ...(config ? [resolveHome(config)] : []),
      resolveHome(path.join(Global.Path.home, ".pawwork")),
      path.resolve(Global.Path.config),
    ])
  }

  export function fileCandidates(name: string) {
    return candidates().map((dir) => path.join(dir, name))
  }

  export function instructionFiles() {
    return fileCandidates("AGENTS.md")
  }

  export function configFilesIn(dir: string) {
    return [path.join(dir, "pawwork.json"), path.join(dir, "pawwork.jsonc")]
  }

  export function configFilesToLoad() {
    for (const dir of candidates()) {
      const files = configFilesIn(dir).filter(isFile)
      if (files.length) return files
    }
    return []
  }

  export function configFileForWrite() {
    const primaryDir = primary()
    const [json, jsonc] = configFilesIn(primaryDir)
    for (const file of [jsonc, json]) {
      if (!fsNode.existsSync(file)) continue
      if (!isFile(file)) throw new Error(`PawWork config path exists but is not a file: ${file}`)
      return file
    }
    return json
  }

  export function existingResourceDirectories() {
    return candidates()
      .filter(isDirectory)
      .toReversed()
  }

  export async function ensurePrimary() {
    const dir = primary()
    const stat = await fs.stat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (stat && !stat.isDirectory()) throw new Error(`PawWork Home exists but is not a directory: ${dir}`)
    if (!stat) await fs.mkdir(dir, { recursive: true })
    return dir
  }

  export function isCandidate(dir: string) {
    const resolved = normalize(dir)
    return candidates().some((candidate) => normalize(candidate) === resolved)
  }

  export function isPrimary(dir: string) {
    return normalize(dir) === normalize(primary())
  }
}
