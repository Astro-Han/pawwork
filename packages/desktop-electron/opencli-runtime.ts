import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

type PackageJson = {
  name?: string
  dependencies?: Record<string, string>
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

function readPackageJson(packageDir: string): PackageJson {
  return JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as PackageJson
}

function packageRootFromResolvedEntry(packageName: string, resolvedEntry: string) {
  let dir = path.dirname(resolvedEntry)
  while (true) {
    const packageJsonPath = path.join(dir, "package.json")
    if (existsSync(packageJsonPath)) {
      const json = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson
      if (json.name === packageName) return dir
    }

    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error(`Could not find package root for ${packageName} from ${resolvedEntry}`)
    }
    dir = parent
  }
}

function resolvePackageRoot(packageName: string, issuerPackageDir: string) {
  const resolver = createRequire(path.join(issuerPackageDir, "package.json"))
  const resolvedEntry = resolver.resolve(packageName)
  if (path.isAbsolute(resolvedEntry)) return packageRootFromResolvedEntry(packageName, resolvedEntry)
  // Bun resolves its built-in `undici` compatibility entry to the bare
  // specifier. The installed package still exposes package.json in this layout,
  // so use it only as a narrow fallback for non-path results.
  return path.dirname(resolver.resolve(`${packageName}/package.json`))
}

export function openCliRuntimePackages() {
  const packages: Array<{ name: string; dir: string; json: PackageJson }> = []
  const seen = new Map<string, string>()

  function visit(packageName: string, issuerPackageDir: string) {
    const dir = resolvePackageRoot(packageName, issuerPackageDir)
    const previous = seen.get(packageName)
    if (previous) {
      if (previous !== dir) throw new Error(`Multiple runtime copies found for ${packageName}: ${previous}, ${dir}`)
      return
    }

    const json = readPackageJson(dir)
    seen.set(packageName, dir)
    packages.push({ name: packageName, dir, json })
    for (const dependency of Object.keys(json.dependencies ?? {}).sort()) {
      visit(dependency, dir)
    }
  }

  visit("@jackwener/opencli", path.join(rootDir, "packages", "opencode"))
  return packages.sort((a, b) => a.name.localeCompare(b.name))
}

export function openCliRuntimePackageNames() {
  return openCliRuntimePackages().map((pkg) => pkg.name)
}

const runtimeOnlyExcludes = [
  "!**/.yarn/**",
  "!**/{test,tests,__tests__,coverage}/**",
  "!**/*.{test,spec}.{js,mjs,cjs,ts,tsx}",
]
const openCliRuntimeFiles = ["package.json", "README.md", "LICENSE", "cli-manifest.json"]
const openCliRuntimeDirectories = ["clis", "dist/src"]
const openCliRuntimeExcludes = ["clis/test-utils.js"]

function normalizeRelativePath(relativePath: string) {
  return relativePath.split(path.sep).join("/")
}

function isNonRuntimePath(relativePath: string) {
  const normalized = normalizeRelativePath(relativePath)
  const parts = normalized.split("/")
  if (parts.some((part) => part === ".yarn" || part === "test" || part === "tests" || part === "__tests__" || part === "coverage")) {
    return true
  }
  const basename = parts.at(-1) ?? ""
  return /\.(test|spec)\.(js|mjs|cjs|ts|tsx)$/.test(basename)
}

export function includeOpenCliRuntimeFile(packageName: string, relativePath: string) {
  const normalized = normalizeRelativePath(relativePath)
  if (isNonRuntimePath(normalized)) return false
  if (packageName !== "@jackwener/opencli") return true
  if (openCliRuntimeExcludes.includes(normalized)) return false
  return (
    openCliRuntimeFiles.includes(normalized) ||
    openCliRuntimeDirectories.some((dir) => normalized.startsWith(`${dir}/`))
  )
}

export function includeOpenCliRuntimeDirectory(packageName: string, relativePath: string) {
  const normalized = normalizeRelativePath(relativePath)
  if (normalized === "") return true
  if (isNonRuntimePath(normalized)) return false
  if (packageName !== "@jackwener/opencli") return true
  return openCliRuntimeDirectories.some(
    (dir) => normalized === dir || normalized.startsWith(`${dir}/`) || dir.startsWith(`${normalized}/`),
  )
}

function openCliRuntimeFilter(packageName: string) {
  const includes =
    packageName === "@jackwener/opencli"
      ? [...openCliRuntimeFiles, ...openCliRuntimeDirectories.map((dir) => `${dir}/**/*`)]
      : ["**/*"]
  const packageExcludes = packageName === "@jackwener/opencli" ? openCliRuntimeExcludes.map((file) => `!${file}`) : []
  return [...includes, ...runtimeOnlyExcludes, ...packageExcludes]
}

export function openCliRuntimeFileSets() {
  return openCliRuntimePackages().map((pkg) => ({
    from: pkg.dir,
    to: path.join("node_modules", ...pkg.name.split("/")),
    filter: openCliRuntimeFilter(pkg.name),
  }))
}
