import path from "path"
import { builtinModules, isBuiltin } from "module"
import { Filesystem } from "@/util/filesystem"

const DEPENDENCY_IMPORT =
  /(?:^|\n)\s*(?:import\s+(?:[^"'`]+\s+from\s+)?|export\s+[^"'`]+\s+from\s+)["']([^./"'`][^"'`]*)["']|import\s*\(\s*["']([^./"'`][^"'`]*)["']\s*\)|require\(\s*["']([^./"'`][^"'`]*)["']\s*\)/gm
const LOCAL_IMPORT =
  /(?:^|\n)\s*(?:import\s+(?:[^"'`]+\s+from\s+)?|export\s+[^"'`]+\s+from\s+)["']((?:\.\.?\/)[^"'`]*)["']|import\s*\(\s*["']((?:\.\.?\/)[^"'`]*)["']\s*\)|require\(\s*["']((?:\.\.?\/)[^"'`]*)["']\s*\)/gm
const BUILTIN_MODULES = new Set(builtinModules)
const LOCAL_IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]

function packageName(spec: string) {
  if (spec.startsWith("node:") || isBuiltin(spec) || BUILTIN_MODULES.has(spec)) return
  if (spec.startsWith("@")) {
    const [scope, name] = spec.split("/")
    if (!scope || !name) return
    return `${scope}/${name}`
  }
  return spec.split("/")[0]
}

async function resolveLocalImport(file: string, spec: string) {
  const target = path.resolve(path.dirname(file), spec)
  const candidates = path.extname(target)
    ? [target]
    : [
        ...LOCAL_IMPORT_EXTENSIONS.map((ext) => `${target}${ext}`),
        ...LOCAL_IMPORT_EXTENSIONS.map((ext) => path.join(target, `index${ext}`)),
      ]
  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) return candidate
  }
}

/**
 * Returns true when a local config file imports a package that is not fully
 * installed under the config directory.
 */
export async function needsConfigDependencies(file: string, configDir: string, visited = new Set<string>()) {
  const resolved = path.resolve(file)
  if (visited.has(resolved)) return false
  visited.add(resolved)

  const text = await Filesystem.readText(resolved).catch(() => "")
  DEPENDENCY_IMPORT.lastIndex = 0
  for (const match of text.matchAll(DEPENDENCY_IMPORT)) {
    const spec = match[1] ?? match[2] ?? match[3]
    if (!spec) continue
    const pkg = packageName(spec)
    if (!pkg) continue
    const pkgPath = path.join(configDir, "node_modules", ...pkg.split("/"))
    if (await Filesystem.exists(path.join(pkgPath, "package.json"))) continue
    return true
  }

  LOCAL_IMPORT.lastIndex = 0
  for (const match of text.matchAll(LOCAL_IMPORT)) {
    const spec = match[1] ?? match[2] ?? match[3]
    if (!spec) continue
    const next = await resolveLocalImport(resolved, spec)
    if (!next) continue
    if (await needsConfigDependencies(next, configDir, visited)) return true
  }

  return false
}

/**
 * Returns true when a local config file graph references any bare package
 * import. Callers use this to wait for an in-progress config install even when
 * package metadata already exists but entrypoint files may still be settling.
 */
export async function usesConfigDependencies(file: string, visited = new Set<string>()) {
  const resolved = path.resolve(file)
  if (visited.has(resolved)) return false
  visited.add(resolved)

  const text = await Filesystem.readText(resolved).catch(() => "")
  DEPENDENCY_IMPORT.lastIndex = 0
  for (const match of text.matchAll(DEPENDENCY_IMPORT)) {
    const spec = match[1] ?? match[2] ?? match[3]
    if (!spec) continue
    if (packageName(spec)) return true
  }

  LOCAL_IMPORT.lastIndex = 0
  for (const match of text.matchAll(LOCAL_IMPORT)) {
    const spec = match[1] ?? match[2] ?? match[3]
    if (!spec) continue
    const next = await resolveLocalImport(resolved, spec)
    if (!next) continue
    if (await usesConfigDependencies(next, visited)) return true
  }

  return false
}
