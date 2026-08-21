import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"

// DSH 的凭据文档自 dsh 0.1.1-rc.1 起是版本化的：`refs:` 存引用名到值的映射，
// `records:` 存登录态。旧的扁平映射仍会在 boot 时被就地迁移，但种子直接写成
// 目标格式，新建的 product home 就不必走一次迁移。
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

// The window is created before DSH is asked to start, so it needs the preload
// path before prepareDshProductHome has run. Resolving it is pure path work; the
// preparation below is not, which is why the two are separate.
export function dshFileInputPreload(resources: string) {
  return join(resources, "product", "preload.cjs")
}

export function prepareDshProductHome(options: PrepareDshProductHomeOptions) {
  if (!isAbsolute(options.productHome)) throw new Error("DSH product home must be absolute")

  mkdirSync(options.productHome, { recursive: true })
  cpSync(join(options.resources, "home"), options.productHome, { force: true, recursive: true })
  const productPackageParent = join(options.productHome, "node_modules", "@pawwork")
  mkdirSync(productPackageParent, { recursive: true })
  cpSync(join(options.resources, "product"), join(productPackageParent, "dsh-product"), {
    force: true,
    recursive: true,
  })
  cpSync(join(options.resources, "automations"), join(productPackageParent, "dsh-automations"), {
    force: true,
    recursive: true,
  })

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
