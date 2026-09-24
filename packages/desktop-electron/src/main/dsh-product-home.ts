import {
  PROFILES_DIR,
  PROFILE_TEMPLATES,
  initProfile,
  readProfileManifest,
  writeProfileBundles,
} from "@deepseek-ai/dsh-app-boot"
import yaml from "js-yaml"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join } from "node:path"

const PRODUCT_BUNDLE = "@pawwork/dsh-bundle"
const RETIRED_ROUTES = ["opencode", "opencode-responses"]

// An inherited key would reach the sidecar beside the one the Models page writes, and
// credentials-local ranks the environment above its own store, so the store's value would be
// silently shadowed by whatever the launching shell happened to export.
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
    "app",
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "package.json",
  )
}

export function resolvePnpmPackagePath(options: ResolvePnpmPackagePathOptions) {
  if (!options.isPackaged) return options.resolveDevelopmentPackage()
  return join(options.resourcesPath, "app", "node_modules", "pnpm", "package.json")
}

// The app's own module tree, not the tree the installed `dsh` package sits in:
// under pnpm those differ, because a dependency resolves into its own store
// directory that holds only what that package declared. What a product plugin
// needs to reach is what *this* package declared.
export function resolveHostModules(options: ResolveProductResourcesOptions) {
  return options.isPackaged
    ? join(options.resourcesPath, "app", "node_modules")
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
  // Loud, not silent. Without this link every bundled plugin fails to resolve
  // its harness imports, and the product patch points `web.searchProvider` at
  // one of them — so a missing scope is not a degraded feature but every
  // `web_search` answering `configured web provider "pawwork" is not
  // registered`. Returning quietly would ship that as a mystery; throwing puts
  // the real cause on the startup-failure page the lifecycle already renders.
  if (!existsSync(target)) {
    throw new Error(`DSH host module scope is missing at ${target}`)
  }
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
  if (existing?.isSymbolicLink()) {
    // Remove the link itself, including a Windows junction with a missing target.
    unlinkSync(link)
  } else if (existing !== undefined) {
    rmSync(link, { force: true, recursive: true })
  }
  symlinkSync(target, link, "junction")
}

// `dsh web` loads the `web` profile. PawWork's composition is one more bundle on
// top of that template, beneath the user's own profile patch, so settings the user
// saves can override it. Re-selected on every launch because a profile recovery
// resets the bundle list.
function selectProductBundle(profileDir: string) {
  initProfile(profileDir, [...PROFILE_TEMPLATES.web.bundles, PRODUCT_BUNDLE])
  const manifest = readProfileManifest("dsh", profileDir)
  const bundles = manifest.dsh?.profile?.bundles ?? PROFILE_TEMPLATES.web.bundles
  if (!bundles.includes(PRODUCT_BUNDLE)) writeProfileBundles(profileDir, manifest, [...bundles, PRODUCT_BUNDLE])
}

// The retired OpenCode Free tier wrote these routes into the legacy settings file.
// DSH imports that file into the profile once, so they have to go before it does.
function dropRetiredRoutes(home: string) {
  const path = join(home, "settings.yaml")
  if (!existsSync(path)) return
  let sections: { "llm-pi-ai"?: { providers?: Record<string, unknown> } } | undefined
  try {
    sections = yaml.load(readFileSync(path, "utf8")) as typeof sections
  } catch {
    return
  }
  const providers = sections?.["llm-pi-ai"]?.providers
  const retired = RETIRED_ROUTES.filter((route) => providers?.[route] !== undefined)
  if (retired.length === 0) return
  for (const route of retired) delete providers![route]
  writeFileSync(path, yaml.dump(sections))
}

export function prepareDshProductHome(options: PrepareDshProductHomeOptions) {
  if (!isAbsolute(options.productHome)) throw new Error("DSH product home must be absolute")

  const productPackageParent = join(options.productHome, "node_modules", "@pawwork")
  mkdirSync(productPackageParent, { recursive: true })
  for (const plugin of ["bundle", "product", "automations", "identity", "web-search", "updater", "mcp-oauth"] as const) {
    cpSync(join(options.resources, plugin), join(productPackageParent, `dsh-${plugin}`), {
      force: true,
      recursive: true,
    })
  }
  linkHostScope(options.productHome, options.hostModules)
  selectProductBundle(join(options.productHome, PROFILES_DIR, "web"))
  dropRetiredRoutes(options.productHome)

  return {
    home: options.productHome,
    sidecarPreload: join(options.resources, "sidecar-preload.mjs"),
  }
}

export function buildDshEnvironment(
  bundledSkillDir: string,
  source: NodeJS.ProcessEnv = process.env,
) {
  // Windows treats environment names case-insensitively, but this is a plain object: a shell that
  // exported `opencode_api_key` survives a `delete` of the canonical spelling and reaches the
  // sidecar under a second name. Drop on the lowercased name so every spelling leaves with one
  // rule.
  const owned = new Set(
    ["DSH_HOME", "DSH_BUNDLED_SKILL_DIR", ...DROPPED_MODEL_ENVIRONMENT].map((name) =>
      name.toLowerCase(),
    ),
  )
  return {
    ...Object.fromEntries(Object.entries(source).filter(([name]) => !owned.has(name.toLowerCase()))),
    DSH_BUNDLED_SKILL_DIR: bundledSkillDir,
  } satisfies NodeJS.ProcessEnv
}
