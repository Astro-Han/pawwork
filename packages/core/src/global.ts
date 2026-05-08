import path from "path"
import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Runtime } from "./runtime"

const app = Runtime.appName()
const data = path.join(xdgData!, app)
const cache = path.join(xdgCache!, app)
const config = path.join(xdgConfig!, app)
const state = path.join(xdgState!, app)
const tmp = path.join(state, "tmp")

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

async function ensurePrivateDirectory(dir: string) {
  try {
    const stat = await fs.lstat(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} is not a directory`)
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  }

  const stat = await fs.lstat(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} is not a private directory`)

  if (process.platform !== "win32") {
    const uid = process.getuid?.()
    if (uid !== undefined && stat.uid !== uid) throw new Error(`${dir} is not owned by the current user`)
    if ((stat.mode & 0o077) !== 0) await fs.chmod(dir, 0o700)
  }
}

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
])
await ensurePrivateDirectory(Path.tmp)

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({
      home: Path.home,
      data: Path.data,
      cache: Path.cache,
      config: Path.config,
      state: Path.state,
      tmp: Path.tmp,
      bin: Path.bin,
      log: Path.log,
    })
  }),
)

export * as Global from "./global"
