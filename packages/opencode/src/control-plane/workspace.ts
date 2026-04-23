import z from "zod"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect } from "effect"
import { fn } from "@/util/fn"
import { Database, eq } from "@/storage/db"
import { Project } from "@/project/project"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { SyncEvent } from "@/sync"
import { Log } from "@/util/log"
import { Filesystem } from "@/util/filesystem"
import { ProjectID } from "@/project/schema"
import { Instance } from "@/project/instance"
import { Plugin } from "@/plugin"
import { Auth } from "@/auth"
import { AppRuntime } from "@/effect/app-runtime"
import { WorkspaceTable } from "./workspace.sql"
import { getAdaptor, getBuiltinAdaptor, ownerKey } from "./adaptors"
import { WorkspaceInfo } from "./types"
import { WorkspaceID } from "./schema"
import { parseSSE } from "./sse"

export namespace Workspace {
  export const Info = WorkspaceInfo.meta({
    ref: "Workspace",
  })
  export type Info = z.infer<typeof Info>
  type StoredInfo = Info & {
    owner: string | null
  }

  export const ConnectionStatus = z.object({
    workspaceID: WorkspaceID.zod,
    status: z.enum(["connected", "connecting", "disconnected", "error"]),
    error: z.string().optional(),
  })
  export type ConnectionStatus = z.infer<typeof ConnectionStatus>

  export const Event = {
    Ready: BusEvent.define(
      "workspace.ready",
      z.object({
        name: z.string(),
      }),
    ),
    Failed: BusEvent.define(
      "workspace.failed",
      z.object({
        message: z.string(),
      }),
    ),
    Status: BusEvent.define("workspace.status", ConnectionStatus),
  }

  function fromRow(row: typeof WorkspaceTable.$inferSelect): StoredInfo {
    return {
      id: row.id,
      type: row.type,
      branch: row.branch,
      name: row.name,
      directory: row.directory,
      owner: row.owner_directory,
      extra: row.extra,
      projectID: row.project_id,
    }
  }

  function toInfo(row: StoredInfo): Info {
    return {
      id: row.id,
      type: row.type,
      branch: row.branch,
      name: row.name,
      directory: row.directory,
      extra: row.extra,
      projectID: row.projectID,
    }
  }

  const CreateInput = z.object({
    id: WorkspaceID.zod.optional(),
    type: Info.shape.type,
    branch: Info.shape.branch,
    projectID: ProjectID.zod,
    extra: Info.shape.extra,
  })

  async function bootstrapAdaptor(
    input: Pick<StoredInfo, "projectID" | "type" | "owner"> & { hint?: string | null },
    error: unknown,
  ) {
    const project = Project.get(input.projectID)
    if (!project) throw error
    const projectWorktree = project.worktree === "/" ? undefined : project.worktree

    const candidates = [
      ...new Set(
        [input.hint, input.owner, projectWorktree, ...project.sandboxes].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ]
    let lastError = error
    const resolved: { owner: string; adaptor: Awaited<ReturnType<typeof getAdaptor>> }[] = []

    for (const directory of candidates) {
      try {
        const match = await Instance.provide({
          directory,
          fn: async () => {
            await Plugin.init()
            const owner = ownerKey(Instance.directory, Instance.worktree)
            return {
              owner,
              adaptor: await getAdaptor(input.projectID, input.type, owner),
            }
          },
        })

        if (input.owner) {
          if (match.owner === input.owner) return match.adaptor
          continue
        }

        if (!resolved.some((item) => item.owner === match.owner)) {
          resolved.push(match)
        }
      } catch (candidateError) {
        lastError = candidateError
      }
    }

    if (!input.owner) {
      if (resolved.length === 1) return resolved[0]!.adaptor
      if (resolved.length > 1) {
        throw new Error(`Ambiguous workspace adaptor owner for ${input.type}`)
      }
    }

    throw lastError
  }

  export async function resolveAdaptor(
    input: Pick<StoredInfo, "projectID" | "type" | "owner"> & { hint?: string | null },
  ) {
    const hint =
      input.hint ??
      (() => {
        try {
          return ownerKey(Instance.directory, Instance.worktree)
        } catch {
          return undefined
        }
      })()

    if (input.owner) {
      try {
        return await getAdaptor(input.projectID, input.type, input.owner)
      } catch (error) {
        return bootstrapAdaptor({ ...input, hint }, error)
      }
    }

    const builtin = getBuiltinAdaptor(input.type)
    if (builtin) return builtin()

    const project = Project.get(input.projectID)
    if (project?.worktree === "/" && !hint) {
      throw new Error(`Missing workspace owner for non-git adaptor: ${input.type}`)
    }

    return bootstrapAdaptor({ ...input, hint }, new Error(`Missing workspace owner for adaptor: ${input.type}`))
  }

  export const create = fn(CreateInput, async (input) => {
    const id = WorkspaceID.ascending(input.id)
    const owner = ownerKey(Instance.directory, Instance.worktree)
    const adaptor = await getAdaptor(input.projectID, input.type, owner)

    const config = await adaptor.configure({ ...input, id, name: null, directory: null })

    const info: StoredInfo = {
      id,
      type: config.type,
      branch: config.branch ?? null,
      name: config.name ?? null,
      directory: config.directory ?? null,
      owner,
      extra: config.extra ?? null,
      projectID: input.projectID,
    }

    Database.use((db) => {
      db.insert(WorkspaceTable)
        .values({
          id: info.id,
          type: info.type,
          branch: info.branch,
          name: info.name,
          directory: info.directory,
          owner_directory: info.owner,
          extra: info.extra,
          project_id: info.projectID,
        })
        .run()
    })

    const requestedProviders = [...new Set(adaptor.auth?.providers ?? [])]
    const scopedAuth =
      requestedProviders.length === 0
        ? undefined
        : await AppRuntime.runPromise(
            Auth.Service.use((auth) =>
              Effect.gen(function* () {
                const all = yield* auth.all()
                return Object.fromEntries(
                  requestedProviders
                    .map((provider) => [provider, all[provider]] as const)
                    .filter(([, value]) => value !== undefined),
                )
              }),
            ),
          )

    const env = Object.fromEntries(
      Object.entries({
        OPENCODE_AUTH_CONTENT:
          scopedAuth && Object.keys(scopedAuth).length > 0 ? JSON.stringify(scopedAuth) : undefined,
        OPENCODE_WORKSPACE_ID: info.id,
        OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
        OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
        OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES,
      }).filter(([, value]) => value !== undefined),
    ) as Record<string, string>
    await adaptor.create(config, env)

    startSync({ space: info })

    return toInfo(info)
  })

  export function list(project: Project.Info) {
    const rows = Database.use((db) =>
      db.select().from(WorkspaceTable).where(eq(WorkspaceTable.project_id, project.id)).all(),
    )
    const spaces = rows.map(fromRow).sort((a, b) => a.id.localeCompare(b.id))
    for (const space of spaces) startSync({ space })
    return spaces.map(toInfo)
  }

  export const record = fn(WorkspaceID.zod, async (id) => {
    const row = Database.use((db) => db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get())
    if (!row) return
    return fromRow(row)
  })

  export const get = fn(WorkspaceID.zod, async (id) => {
    const space = await record(id)
    if (!space) return
    startSync({ space })
    return toInfo(space)
  })

  export function ensureSync(space: Awaited<ReturnType<typeof record>> | undefined, hint?: string | null) {
    if (!space) return
    startSync({ space, hint })
  }

  export const remove = fn(WorkspaceID.zod, async (id) => {
    const info = await record(id)
    if (info) {
      stopSync(id)

      const adaptor = await resolveAdaptor(info)
      await adaptor.remove(info)
      Database.use((db) => db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, id)).run())
      return toInfo(info)
    }
  })

  const connections = new Map<WorkspaceID, ConnectionStatus>()
  type SyncRequest = {
    space: StoredInfo
    hint?: string | null
  }

  const aborts = new Map<WorkspaceID, AbortController>()
  const pending = new Map<WorkspaceID, SyncRequest>()

  function setStatus(id: WorkspaceID, status: ConnectionStatus["status"], error?: string) {
    const prev = connections.get(id)
    if (prev?.status === status && prev?.error === error) return
    const next = { workspaceID: id, status, error }
    connections.set(id, next)
    GlobalBus.emit("event", {
      directory: "global",
      workspace: id,
      payload: {
        type: Event.Status.type,
        properties: next,
      },
    })
  }

  export function status(): ConnectionStatus[] {
    return [...connections.values()]
  }

  const log = Log.create({ service: "workspace-sync" })

  async function workspaceEventLoop(input: SyncRequest, signal: AbortSignal) {
    const space = input.space
    log.info("starting sync: " + space.id)

    while (!signal.aborted) {
      log.info("connecting to sync: " + space.id)

      setStatus(space.id, "connecting")
      const adaptor = await resolveAdaptor({ ...space, hint: input.hint })
      const target = await adaptor.target(space)

      if (target.type === "local") {
        const exists = await Filesystem.exists(target.directory)
        setStatus(space.id, exists ? "connected" : "error", exists ? undefined : "directory does not exist")
        return
      }

      const res = await fetch(target.url + "/sync/event", { method: "GET", signal }).catch((err: unknown) => {
        setStatus(space.id, "error", String(err))
        return undefined
      })
      if (!res || !res.ok || !res.body) {
        log.info("failed to connect to sync: " + res?.status)

        setStatus(space.id, "error", res ? `HTTP ${res.status}` : "no response")
        await sleep(1000)
        continue
      }
      setStatus(space.id, "connected")
      await parseSSE(res.body, signal, (evt) => {
        const event = evt as SyncEvent.SerializedEvent

        try {
          if (!event.type.startsWith("server.")) {
            SyncEvent.replay(event)
          }
        } catch (err) {
          log.warn("failed to replay sync event", {
            workspaceID: space.id,
            error: err,
          })
        }
      })
      setStatus(space.id, "disconnected")
      log.info("disconnected to sync: " + space.id)
      await sleep(250)
    }
  }

  function startSync(input: SyncRequest) {
    const space = input.space
    if (space.type === "worktree") {
      void Filesystem.exists(space.directory!).then((exists) => {
        setStatus(space.id, exists ? "connected" : "error", exists ? undefined : "directory does not exist")
      })
      return
    }

    if (aborts.has(space.id)) {
      pending.set(space.id, input)
      return
    }
    const abort = new AbortController()
    aborts.set(space.id, abort)
    setStatus(space.id, "disconnected")

    void workspaceEventLoop(input, abort.signal)
      .catch((error) => {
        setStatus(space.id, "error", String(error))
        log.warn("workspace sync listener failed", {
          workspaceID: space.id,
          error,
        })
      })
      .finally(() => {
        if (aborts.get(space.id) === abort) {
          aborts.delete(space.id)
        }
        const next = pending.get(space.id)
        if (!next) return
        pending.delete(space.id)
        startSync(next)
      })
  }

  function stopSync(id: WorkspaceID) {
    aborts.get(id)?.abort()
    aborts.delete(id)
    pending.delete(id)
    connections.delete(id)
  }
}
