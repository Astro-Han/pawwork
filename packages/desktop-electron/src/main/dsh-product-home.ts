import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"

// Boot migrates a pre-0.1.1-rc.1 flat credential map into `version: 1` in place, so seeding the
// versioned form directly is what keeps a fresh product home out of that migration.
const PUBLIC_CREDENTIAL = 'version: 1\nrefs:\n  OPENCODE_API_KEY: "public"\n'
const DROPPED_MODEL_ENVIRONMENT = [
  "OPENCODE_API_KEY",
  "OPENCODE_GO_API_KEY",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
] as const

type PrepareDshProductHomeOptions = {
  productHome: string
  resources: string
  hostModules: string
}

type ResolveProductResourcesOptions = {
  appPath: string
  isPackaged: boolean
  resourcesPath: string
}

type ResolveDshPackagePathOptions = {
  isPackaged: boolean
  resourcesPath: string
  resolveDevelopmentPackage: () => string
}

type ResolvePnpmPackagePathOptions = ResolveDshPackagePathOptions

export function resolveProductResources(options: ResolveProductResourcesOptions) {
  return {
    dsh: options.isPackaged
      ? join(options.resourcesPath, "dsh")
      : join(options.appPath, "resources", "dsh"),
    skills: options.isPackaged
      ? join(options.resourcesPath, "skills")
      : join(options.appPath, "..", "..", "skills"),
  }
}

export function resolveDshPackagePath(options: ResolveDshPackagePathOptions) {
  if (!options.isPackaged) return options.resolveDevelopmentPackage()
  return join(
    options.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "package.json",
  )
}

export function resolvePnpmPackagePath(options: ResolvePnpmPackagePathOptions) {
  if (!options.isPackaged) return options.resolveDevelopmentPackage()
  return join(options.resourcesPath, "app.asar.unpacked", "node_modules", "pnpm", "package.json")
}

// The app's own module tree, not the tree the installed `dsh` package sits in:
// under pnpm those differ, because a dependency resolves into its own store
// directory that holds only what that package declared. What a product plugin
// needs to reach is what *this* package declared.
export function resolveHostModules(options: ResolveProductResourcesOptions) {
  return options.isPackaged
    ? join(options.resourcesPath, "app.asar.unpacked", "node_modules")
    : join(options.appPath, "node_modules")
}

// Product plugins live under the home, not under the host's own tree, so Node
// resolves their imports from `<home>/node_modules` upward and never reaches the
// harness packages the app ships. Linking the host's `@deepseek-ai` scope in is
// what lets a product plugin build on a DSH implementation package instead of
// restating its wire format — and it points at the very packages the running app
// loaded, so the plugin cannot bind a second copy at a different version.
function linkHostScope(productHome: string, hostModules: string) {
  const target = join(hostModules, "@deepseek-ai")
  if (!existsSync(target)) return
  const link = join(productHome, "node_modules", "@deepseek-ai")
  // `lstatSync`, not `existsSync`: the link this replaces is usually dangling —
  // "run once from Downloads, then drag to /Applications" moves the host tree
  // out from under it — and `existsSync` follows symlinks, so it reports a
  // dangling link as absent and the `symlinkSync` below then fails `EEXIST`
  // on every launch thereafter.
  const existing = lstatSync(link, { throwIfNoEntry: false })
  // An upgrade moves the host tree, so a link surviving from an older install
  // would resolve to packages that are no longer there.
  if (existing?.isSymbolicLink() === true && readlinkSync(link) === target) return
  if (existing !== undefined) rmSync(link, { force: true, recursive: true })
  symlinkSync(target, link, "junction")
}

export function prepareDshProductHome(options: PrepareDshProductHomeOptions) {
  if (!isAbsolute(options.productHome)) throw new Error("DSH product home must be absolute")

  mkdirSync(options.productHome, { recursive: true })
  cpSync(join(options.resources, "home"), options.productHome, { force: true, recursive: true })
  const productPackageParent = join(options.productHome, "node_modules", "@pawwork")
  mkdirSync(productPackageParent, { recursive: true })
  for (const plugin of ["product", "automations", "identity", "web-search"] as const) {
    cpSync(join(options.resources, plugin), join(productPackageParent, `dsh-${plugin}`), {
      force: true,
      recursive: true,
    })
  }
  linkHostScope(options.productHome, options.hostModules)

  const credentials = join(options.productHome, ".credentials.yaml")
  if (!existsSync(credentials)) writeFileSync(credentials, PUBLIC_CREDENTIAL, { mode: 0o600 })

  return {
    home: options.productHome,
    patch: join(options.productHome, "product.cordis.patch.yml"),
    sidecarPreload: join(options.resources, "sidecar-preload.mjs"),
  }
}

export function buildDshEnvironment(
  bundledSkillDir: string,
  source: NodeJS.ProcessEnv = process.env,
) {
  const environment: NodeJS.ProcessEnv = {
    ...source,
    DSH_BUNDLED_SKILL_DIR: bundledSkillDir,
  }
  delete environment.DSH_HOME
  for (const name of DROPPED_MODEL_ENVIRONMENT) delete environment[name]
  return environment
}
