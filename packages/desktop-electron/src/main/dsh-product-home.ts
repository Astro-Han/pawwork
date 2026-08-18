import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"

const PUBLIC_CREDENTIAL = 'OPENCODE_API_KEY: "public"\n'
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

type ResolveDshResourcesOptions = {
  appPath: string
  isPackaged: boolean
  resourcesPath: string
}

type ResolveDshPackagePathOptions = {
  isPackaged: boolean
  resourcesPath: string
  resolveDevelopmentPackage: () => string
}

export function resolveDshResources(options: ResolveDshResourcesOptions) {
  return options.isPackaged
    ? join(options.resourcesPath, "dsh")
    : join(options.appPath, "resources", "dsh")
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

export function prepareDshProductHome(options: PrepareDshProductHomeOptions) {
  if (!isAbsolute(options.productHome)) throw new Error("DSH product home must be absolute")

  mkdirSync(options.productHome, { recursive: true })
  cpSync(join(options.resources, "home"), options.productHome, { force: true, recursive: true })

  const credentials = join(options.productHome, ".credentials.yaml")
  if (!existsSync(credentials)) writeFileSync(credentials, PUBLIC_CREDENTIAL, { mode: 0o600 })

  return {
    home: options.productHome,
    patch: join(options.productHome, "product.cordis.patch.yml"),
    zenIdentityPreload: join(options.resources, "zen-identity-preload.mjs"),
  }
}

export function buildDshEnvironment(productHome: string, source: NodeJS.ProcessEnv = process.env) {
  const environment: NodeJS.ProcessEnv = { ...source, DSH_HOME: productHome }
  for (const name of DROPPED_MODEL_ENVIRONMENT) delete environment[name]
  return environment
}
