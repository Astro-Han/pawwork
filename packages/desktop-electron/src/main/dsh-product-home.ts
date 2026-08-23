import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
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

export function prepareDshProductHome(options: PrepareDshProductHomeOptions) {
  if (!isAbsolute(options.productHome)) throw new Error("DSH product home must be absolute")

  mkdirSync(options.productHome, { recursive: true })
  cpSync(join(options.resources, "home"), options.productHome, { force: true, recursive: true })
  const productPackageParent = join(options.productHome, "node_modules", "@pawwork")
  mkdirSync(productPackageParent, { recursive: true })
  for (const plugin of ["product", "automations", "identity"] as const) {
    cpSync(join(options.resources, plugin), join(productPackageParent, `dsh-${plugin}`), {
      force: true,
      recursive: true,
    })
  }

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
