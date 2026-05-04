import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Instance } from "@/project/instance"
import type { Proc } from "#pty"
import z from "zod"
import { Log } from "@opencode-ai/core/util/log"
import { lazy } from "@opencode-ai/util/lazy"
import { Shell } from "@/shell/shell"
import { Plugin } from "@/plugin"
import { envValueCaseInsensitive, withoutInternalServerAuthEnv } from "@/util/env"
import { PtyID } from "./schema"
import { Effect, Layer, Context } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import { setTimeout as sleep } from "node:timers/promises"

export namespace Pty {
  const log = Log.create({ service: "pty" })

  const BUFFER_LIMIT = 1024 * 1024 * 2
  const BUFFER_CHUNK = 64 * 1024
  const TERMINATION_GRACE_MS = 200
  const EXIT_WAIT_MS = 1000
  const encoder = new TextEncoder()

  type Socket = {
    readyState: number
    data?: unknown
    send: (data: string | Uint8Array | ArrayBuffer) => void
    close: (code?: number, reason?: string) => void
  }

  const sock = (ws: Socket) => (ws.data && typeof ws.data === "object" ? ws.data : ws)

  type Active = {
    info: Info
    process: Proc
    buffer: string
    bufferCursor: number
    cursor: number
    subscribers: Map<unknown, Socket>
  }

  type State = {
    dir: string
    sessions: Map<PtyID, Active>
    cleanupTasks: Set<Promise<void>>
  }

  // WebSocket control frame: 0x00 + UTF-8 JSON.
  const meta = (cursor: number) => {
    const json = JSON.stringify({ cursor })
    const bytes = encoder.encode(json)
    const out = new Uint8Array(bytes.length + 1)
    out[0] = 0
    out.set(bytes, 1)
    return out
  }

  const pty = lazy(() => import("#pty"))

  export const Info = z
    .object({
      id: PtyID.zod,
      title: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      status: z.enum(["running", "exited"]),
      pid: z.number(),
    })
    .meta({ ref: "Pty" })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    title: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z.object({
    title: z.string().optional(),
    size: z
      .object({
        rows: z.number(),
        cols: z.number(),
      })
      .optional(),
  })

  export type UpdateInput = z.infer<typeof UpdateInput>

  export const Event = {
    Created: BusEvent.define("pty.created", z.object({ info: Info })),
    Updated: BusEvent.define("pty.updated", z.object({ info: Info })),
    Exited: BusEvent.define("pty.exited", z.object({ id: PtyID.zod, exitCode: z.number() })),
    Deleted: BusEvent.define("pty.deleted", z.object({ id: PtyID.zod })),
  }

  export interface Interface {
    readonly list: () => Effect.Effect<Info[]>
    readonly get: (id: PtyID) => Effect.Effect<Info | undefined>
    readonly create: (input: CreateInput) => Effect.Effect<Info>
    readonly update: (id: PtyID, input: UpdateInput) => Effect.Effect<Info | undefined>
    readonly remove: (id: PtyID) => Effect.Effect<void>
    readonly resize: (id: PtyID, cols: number, rows: number) => Effect.Effect<void>
    readonly write: (id: PtyID, data: string) => Effect.Effect<void>
    readonly connect: (
      id: PtyID,
      ws: Socket,
      cursor?: number,
    ) => Effect.Effect<{ onMessage: (message: string | ArrayBuffer) => void; onClose: () => void } | undefined>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Pty") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const plugin = yield* Plugin.Service

      function closeSubscribers(session: Active) {
        for (const [sub, ws] of session.subscribers.entries()) {
          try {
            if (sock(ws) === sub) ws.close()
          } catch {}
        }
        session.subscribers.clear()
      }

      function waitForExit(session: Active) {
        if (session.info.status === "exited") return Promise.resolve()
        return new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, EXIT_WAIT_MS)
          const sub = session.process.onExit(() => {
            clearTimeout(timer)
            sub.dispose()
            resolve()
          })
        })
      }

      function processExists(pid: number) {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }

      const hasExited = (session: Active) => session.info.status === "exited" || !processExists(session.process.pid)

      async function descendantPids(pid: number) {
        if (process.platform === "win32") return []
        const seen = new Set<number>()
        const pending = [pid]
        while (pending.length) {
          const parent = pending.pop()!
          const out = await Bun.$`pgrep -P ${parent}`.quiet().nothrow().text()
          for (const line of out.split(/\s+/)) {
            const child = Number(line)
            if (!Number.isInteger(child) || child <= 0 || seen.has(child)) continue
            seen.add(child)
            pending.push(child)
          }
        }
        return Array.from(seen)
      }

      function signalProcess(session: Active, signal: string) {
        if (session.info.status === "exited") return
        try {
          session.process.kill(signal)
        } catch {}
      }

      const terminate = Effect.fn("Pty.terminate")(function* (session: Active) {
        if (hasExited(session)) return
        const exited = waitForExit(session)
        if (process.platform === "win32") {
          signalProcess(session, "SIGTERM")
          yield* Effect.promise(() => exited)
          return
        }

        const descendants = yield* Effect.promise(() => descendantPids(session.process.pid))
        signalProcess(session, "SIGTERM")
        for (const child of descendants) {
          try {
            if (processExists(child)) process.kill(child, "SIGTERM")
          } catch {}
        }
        yield* Effect.promise(() =>
          Promise.race([exited.then(() => true), sleep(TERMINATION_GRACE_MS).then(() => false)]),
        )
        if (hasExited(session)) return
        signalProcess(session, "SIGKILL")
        for (const child of descendants) {
          try {
            if (processExists(child)) process.kill(child, "SIGKILL")
          } catch {}
        }
        yield* Effect.promise(() => exited)
      })

      const teardown = Effect.fn("Pty.teardown")(function* (session: Active) {
        closeSubscribers(session)
        yield* terminate(session)
      })

      const state = yield* InstanceState.make<State>(
        Effect.fn("Pty.state")(function* (ctx) {
          const state = {
            dir: ctx.directory,
            sessions: new Map<PtyID, Active>(),
            cleanupTasks: new Set<Promise<void>>(),
          }

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (state.cleanupTasks.size) {
                yield* Effect.promise(() => Promise.allSettled(state.cleanupTasks)).pipe(Effect.asVoid)
              }
              for (const session of state.sessions.values()) {
                yield* teardown(session)
              }
              state.sessions.clear()
            }),
          )

          return state
        }),
      )

      const trackCleanup = (s: State, effect: Effect.Effect<void>) => {
        const task = Effect.runPromise(effect.pipe(Effect.provide(EffectLogger.layer))).finally(() => {
          s.cleanupTasks.delete(task)
        })
        s.cleanupTasks.add(task)
      }

      const remove = Effect.fn("Pty.remove")(function* (id: PtyID) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (!session) return
        s.sessions.delete(id)
        log.info("removing session", { id })
        yield* teardown(session)
        yield* bus.publish(Event.Deleted, { id: session.info.id })
      })

      const list = Effect.fn("Pty.list")(function* () {
        const s = yield* InstanceState.get(state)
        return Array.from(s.sessions.values()).map((session) => session.info)
      })

      const get = Effect.fn("Pty.get")(function* (id: PtyID) {
        const s = yield* InstanceState.get(state)
        return s.sessions.get(id)?.info
      })

      const create = Effect.fn("Pty.create")(function* (input: CreateInput) {
        const s = yield* InstanceState.get(state)
        const id = PtyID.ascending()
        const command = input.command || Shell.preferred()
        const args = input.args || []
        if (Shell.login(command)) {
          args.push("-l")
        }

        const cwd = input.cwd || s.dir
        const shell = yield* plugin.trigger("shell.env", { cwd }, { env: {} })
        const env = withoutInternalServerAuthEnv({
          ...process.env,
          ...input.env,
          ...shell.env,
          TERM: "xterm-256color",
          OPENCODE_TERMINAL: "1",
        } as Record<string, string>)
        // bun-pty merges with the parent process environment internally, so
        // deleting these keys is not enough for PTY sessions. Override with
        // empty values to prevent PawWork's internal server credentials from
        // being visible inside user terminals.
        env.OPENCODE_SERVER_USERNAME = envValueCaseInsensitive(input.env, "OPENCODE_SERVER_USERNAME") ?? ""
        env.OPENCODE_SERVER_PASSWORD = envValueCaseInsensitive(input.env, "OPENCODE_SERVER_PASSWORD") ?? ""

        if (process.platform === "win32") {
          env.LC_ALL = "C.UTF-8"
          env.LC_CTYPE = "C.UTF-8"
          env.LANG = "C.UTF-8"
        }
        log.info("creating session", { id, cmd: command, args, cwd })

        const { spawn } = yield* Effect.promise(() => pty())
        const proc = yield* Effect.sync(() =>
          spawn(command, args, {
            name: "xterm-256color",
            cwd,
            env,
          }),
        )

        const info = {
          id,
          title: input.title || `Terminal ${id.slice(-4)}`,
          command,
          args,
          cwd,
          status: "running",
          pid: proc.pid,
        } as const
        const session: Active = {
          info,
          process: proc,
          buffer: "",
          bufferCursor: 0,
          cursor: 0,
          subscribers: new Map(),
        }
        s.sessions.set(id, session)
        proc.onData(
          Instance.bind((chunk) => {
            session.cursor += chunk.length

            for (const [key, ws] of session.subscribers.entries()) {
              if (ws.readyState !== 1) {
                session.subscribers.delete(key)
                continue
              }
              if (sock(ws) !== key) {
                session.subscribers.delete(key)
                continue
              }
              try {
                ws.send(chunk)
              } catch {
                session.subscribers.delete(key)
              }
            }

            session.buffer += chunk
            if (session.buffer.length <= BUFFER_LIMIT) return
            const excess = session.buffer.length - BUFFER_LIMIT
            session.buffer = session.buffer.slice(excess)
            session.bufferCursor += excess
          }),
        )
        proc.onExit(
          Instance.bind(({ exitCode }) => {
            if (session.info.status === "exited") return
            log.info("session exited", { id, exitCode })
            session.info.status = "exited"
            trackCleanup(
              s,
              Effect.gen(function* () {
                yield* bus.publish(Event.Exited, { id, exitCode })
                yield* remove(id)
              }),
            )
          }),
        )
        yield* bus.publish(Event.Created, { info })
        return info
      })

      const update = Effect.fn("Pty.update")(function* (id: PtyID, input: UpdateInput) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (!session) return
        if (input.title) {
          session.info.title = input.title
        }
        if (input.size) {
          session.process.resize(input.size.cols, input.size.rows)
        }
        yield* bus.publish(Event.Updated, { info: session.info })
        return session.info
      })

      const resize = Effect.fn("Pty.resize")(function* (id: PtyID, cols: number, rows: number) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (session && session.info.status === "running") {
          session.process.resize(cols, rows)
        }
      })

      const write = Effect.fn("Pty.write")(function* (id: PtyID, data: string) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (session && session.info.status === "running") {
          session.process.write(data)
        }
      })

      const connect = Effect.fn("Pty.connect")(function* (id: PtyID, ws: Socket, cursor?: number) {
        const s = yield* InstanceState.get(state)
        const session = s.sessions.get(id)
        if (!session) {
          ws.close()
          return
        }
        log.info("client connected to session", { id })

        const sub = sock(ws)
        session.subscribers.delete(sub)
        session.subscribers.set(sub, ws)

        const cleanup = () => {
          session.subscribers.delete(sub)
        }

        const start = session.bufferCursor
        const end = session.cursor
        const from =
          cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0

        const data = (() => {
          if (!session.buffer) return ""
          if (from >= end) return ""
          const offset = Math.max(0, from - start)
          if (offset >= session.buffer.length) return ""
          return session.buffer.slice(offset)
        })()

        if (data) {
          try {
            for (let i = 0; i < data.length; i += BUFFER_CHUNK) {
              ws.send(data.slice(i, i + BUFFER_CHUNK))
            }
          } catch {
            cleanup()
            ws.close()
            return
          }
        }

        try {
          ws.send(meta(end))
        } catch {
          cleanup()
          ws.close()
          return
        }

        return {
          onMessage: (message: string | ArrayBuffer) => {
            session.process.write(String(message))
          },
          onClose: () => {
            log.info("client disconnected from session", { id })
            cleanup()
          },
        }
      })

      return Service.of({ list, get, create, update, remove, resize, write, connect })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(Plugin.defaultLayer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function get(id: PtyID) {
    return runPromise((svc) => svc.get(id))
  }

  export async function write(id: PtyID, data: string) {
    return runPromise((svc) => svc.write(id, data))
  }

  export async function connect(id: PtyID, ws: Socket, cursor?: number) {
    return runPromise((svc) => svc.connect(id, ws, cursor))
  }

  export async function create(input: CreateInput) {
    return runPromise((svc) => svc.create(input))
  }

  export async function update(id: PtyID, input: UpdateInput) {
    return runPromise((svc) => svc.update(id, input))
  }

  export async function remove(id: PtyID) {
    return runPromise((svc) => svc.remove(id))
  }
}
