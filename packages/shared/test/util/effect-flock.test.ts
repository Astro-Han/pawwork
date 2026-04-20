import { describe, expect } from "bun:test"
import { spawn } from "child_process"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Effect, Exit, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { EffectFlock } from "@opencode-ai/shared/util/effect-flock"
import { Global } from "@opencode-ai/shared/global"
import { Hash } from "@opencode-ai/shared/util/hash"

function lock(dir: string, key: string) {
  return path.join(dir, Hash.fast(key) + ".lock")
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function exists(file: string) {
  return fs.stat(file).then(() => true).catch(() => false)
}

type Msg = {
  key: string
  dir: string
  holdMs?: number
  ready?: string
  active?: string
  done?: string
}

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/effect-flock-worker.ts")

function run(msg: Msg) {
  return new Promise<{ code: number; stdout: Buffer; stderr: Buffer }>((resolve) => {
    const proc = spawn(process.execPath, [worker, JSON.stringify(msg)], { cwd: root })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    proc.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    proc.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))
    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  })
}

function spawnWorker(msg: Msg) {
  return spawn(process.execPath, [worker, JSON.stringify(msg)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function stopWorker(proc: ReturnType<typeof spawnWorker>) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    const killProc = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"])
    killProc.on("close", () => {
      proc.kill()
      resolve()
    })
  })
}

async function waitForFile(file: string, timeout = 3_000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (await exists(file)) return
    await sleep(20)
  }
  throw new Error(`Timed out waiting for file: ${file}`)
}

const testGlobal = Layer.succeed(
  Global.Service,
  Global.Service.of({
    home: os.homedir(),
    data: os.tmpdir(),
    cache: os.tmpdir(),
    config: os.tmpdir(),
    state: os.tmpdir(),
    bin: os.tmpdir(),
    log: os.tmpdir(),
  }),
)

const testLayer = EffectFlock.layer.pipe(Layer.provide(testGlobal), Layer.provide(AppFileSystem.defaultLayer))

describe("util.effect-flock", () => {
  const it = testEffect(testLayer)

  it.live(
    "acquire and release via scoped Effect",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const lockDir = lock(dir, "eflock:acquire")

      yield* Effect.scoped(flock.acquire("eflock:acquire", dir))

      expect(yield* Effect.promise(() => exists(lockDir))).toBe(false)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "withLock pipeable",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      let hit = false
      yield* Effect.sync(() => {
        hit = true
      }).pipe(flock.withLock("eflock:pipe", dir))
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "recovers after a crashed lock owner",
    () =>
      Effect.promise(async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eflock-crash-"))
        const dir = path.join(tmp, "locks")
        const ready = path.join(tmp, "ready")

        const proc = spawnWorker({ key: "eflock:crash", dir, ready, holdMs: 120_000 })

        try {
          await waitForFile(ready, 5_000)
          await stopWorker(proc)
          await new Promise((resolve) => proc.on("close", resolve))

          const lockDir = lock(dir, "eflock:crash")
          const old = new Date(Date.now() - 120_000)
          await fs.utimes(lockDir, old, old).catch(() => {})
          await fs.utimes(path.join(lockDir, "heartbeat"), old, old).catch(() => {})
          await fs.utimes(path.join(lockDir, "meta.json"), old, old).catch(() => {})

          const done = path.join(tmp, "done.log")
          const result = await run({ key: "eflock:crash", dir, done, holdMs: 10 })
          expect(result.code).toBe(0)
          expect(result.stderr.toString()).toBe("")
        } finally {
          await stopWorker(proc).catch(() => {})
          await fs.rm(tmp, { recursive: true, force: true })
        }
      }),
    30_000,
  )
})
