import fs from "node:fs"
import path from "node:path"

type PackageJson = {
  exports?: unknown
  main?: string
}

type SourceFile = {
  file: string
  source: string
}

export type RuntimeImportKind = "import" | "require"

export type RuntimeImport = {
  kind: RuntimeImportKind
  specifier: string
}

export type RuntimeImportFinding = {
  file: string
  specifier: string
  packageName: string
}

const RUNTIME_IMPORT_RE =
  /\bimport\s+(?!type\b)(?:[^'"`]*?\s+from\s*)?["']([^"']+)["']|\bexport\s+(?!type\b)(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']|\bimport\s*\(\s*(?:["']([^"']+)["']|`([^`$]*)`)\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g

export function extractRuntimeImports(source: string) {
  const imports: RuntimeImport[] = []
  for (const match of source.matchAll(RUNTIME_IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]
    if (!specifier) continue
    imports.push({ kind: match[5] ? "require" : "import", specifier })
  }
  return imports
}

export function packageNameForSpecifier(specifier: string) {
  if (!specifier.startsWith("@")) return specifier.split("/")[0] ?? specifier
  const parts = specifier.split("/")
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
}

function runtimeExportTargetStrings(value: unknown, kind: RuntimeImportKind): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap((entry) => runtimeExportTargetStrings(entry, kind))
  if (!value || typeof value !== "object") return []

  const entries = value as Record<string, unknown>
  const activeConditions = new Set(["node", kind, "default"])
  const hasConditionKeys = Object.keys(entries).some(
    (key) => key === "node" || key === "import" || key === "require" || key === "default",
  )
  if (hasConditionKeys) {
    for (const [key, entry] of Object.entries(entries)) {
      if (activeConditions.has(key)) return runtimeExportTargetStrings(entry, kind)
    }
    return []
  }

  return Object.entries(entries).flatMap(([key, entry]) =>
    key === "types" ? [] : runtimeExportTargetStrings(entry, kind),
  )
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function packageSubpath(packageName: string, specifier: string) {
  if (specifier === packageName) return "."
  return `.${specifier.slice(packageName.length)}`
}

function exportEntryForSubpath(exports: unknown, subpath: string): unknown {
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) return subpath === "." ? exports : undefined
  const entries = exports as Record<string, unknown>
  if (subpath === "." && !Object.keys(entries).some((key) => key.startsWith("."))) return entries
  if (Object.hasOwn(entries, subpath)) return entries[subpath]
  let bestMatch: { key: string; value: unknown } | undefined
  for (const [key, value] of Object.entries(entries)) {
    if (!key.includes("*")) continue
    const pattern = new RegExp(`^${escapeRegExp(key).replace("\\*", "(.+)")}$`)
    if (pattern.test(subpath) && (!bestMatch || key.length > bestMatch.key.length)) bestMatch = { key, value }
  }
  return bestMatch?.value
}

export function packageExportsTypeScriptSourceForSpecifier(
  json: PackageJson,
  packageName: string,
  specifier: string,
  kind: RuntimeImportKind,
) {
  const entry = exportEntryForSubpath(json.exports, packageSubpath(packageName, specifier))
  return runtimeExportTargetStrings(entry, kind).some(
    (target) => /\.(?:ts|tsx)$/.test(target) && !/\.d\.ts$/.test(target),
  )
}

export function findTsSourceRuntimeImports(files: SourceFile[], packageJsonByName: Map<string, PackageJson>) {
  const findings: RuntimeImportFinding[] = []

  for (const file of files) {
    for (const { kind, specifier } of extractRuntimeImports(file.source)) {
      if (!specifier.startsWith("@opencode-ai/")) continue
      const packageName = packageNameForSpecifier(specifier)
      const packageJson = packageJsonByName.get(packageName)
      if (!packageJson || !packageExportsTypeScriptSourceForSpecifier(packageJson, packageName, specifier, kind))
        continue
      findings.push({ file: file.file, specifier, packageName })
    }
  }

  return findings
}

export function readBuiltRuntimeFiles(root: string) {
  const result: SourceFile[] = []
  for (const relDir of ["out/main", "out/preload"]) {
    const dir = path.join(root, relDir)
    if (!fs.existsSync(dir)) continue
    for (const file of walk(dir)) {
      if (!/\.(?:cjs|mjs|js)$/.test(file)) continue
      result.push({
        file: path.relative(root, file),
        source: fs.readFileSync(file, "utf8"),
      })
    }
  }
  if (result.length === 0) throw new Error("No Electron main/preload JavaScript output files found")
  return result
}

function findWorkspaceRoot(root: string) {
  let current = path.resolve(root)
  while (true) {
    const packageJsonPath = path.join(current, "package.json")
    if (fs.existsSync(packageJsonPath)) {
      const json = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { workspaces?: { packages?: string[] } }
      if (json.workspaces?.packages) return current
    }

    const parent = path.dirname(current)
    if (parent === current) throw new Error(`Could not find workspace root from ${root}`)
    current = parent
  }
}

export function findWorkspacePackageJsonPath(root: string, packageName: string) {
  const repoRoot = findWorkspaceRoot(root)
  const rootPackageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    workspaces?: { packages?: string[] }
  }
  const workspacePatterns = rootPackageJson.workspaces?.packages ?? []
  const packageJsonPaths = workspacePatterns.flatMap((pattern) => {
    if (pattern.endsWith("/*")) {
      const base = path.join(repoRoot, pattern.slice(0, -2))
      if (!fs.existsSync(base)) return []
      return fs
        .readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(base, entry.name, "package.json"))
    }
    return [path.join(repoRoot, pattern, "package.json")]
  })

  return packageJsonPaths.find((packageJsonPath) => {
    if (!fs.existsSync(packageJsonPath)) return false
    const json = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string }
    return json.name === packageName
  })
}

function readPackageJson(root: string, packageName: string): PackageJson | undefined {
  const nodeModulesPackageJson = path.join(root, "node_modules", ...packageName.split("/"), "package.json")
  const packageJsonPath = fs.existsSync(nodeModulesPackageJson)
    ? nodeModulesPackageJson
    : findWorkspacePackageJsonPath(root, packageName)
  if (!packageJsonPath) return undefined
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageJson
}

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

export function runRuntimeImportGuard(root = process.cwd()) {
  const files = readBuiltRuntimeFiles(root)
  const packageNames = new Set<string>()
  for (const file of files) {
    for (const { specifier } of extractRuntimeImports(file.source)) {
      if (specifier.startsWith("@opencode-ai/")) packageNames.add(packageNameForSpecifier(specifier))
    }
  }

  const packageJsonByName = new Map<string, PackageJson>()
  const missingPackages: string[] = []
  for (const packageName of packageNames) {
    const packageJson = readPackageJson(root, packageName)
    if (packageJson) {
      packageJsonByName.set(packageName, packageJson)
      continue
    }
    missingPackages.push(packageName)
  }

  if (missingPackages.length > 0) {
    throw new Error(`Could not resolve package.json for runtime imports: ${missingPackages.sort().join(", ")}`)
  }

  return findTsSourceRuntimeImports(files, packageJsonByName)
}

if (import.meta.main) {
  const findings = runRuntimeImportGuard(process.cwd())
  if (findings.length > 0) {
    console.error("Electron main/preload output imports workspace packages that export TypeScript source:")
    for (const finding of findings) {
      console.error(`- ${finding.file}: ${finding.specifier} via ${finding.packageName}`)
    }
    process.exit(1)
  }
}
