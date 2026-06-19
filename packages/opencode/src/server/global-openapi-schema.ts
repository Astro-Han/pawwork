import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import z from "zod"

export function globalEventOpenApiSchema(options?: { busEventTypes?: Iterable<string> }) {
  return z
    .object({
      directory: z.string(),
      project: z.string().optional(),
      workspace: z.string().optional(),
      payload: BusEvent.payloads({ include: options?.busEventTypes }),
    })
    .meta({
      ref: "GlobalEvent",
    })
}

export function globalSyncEventOpenApiSchema(options?: { syncEventTypes?: Iterable<string> }) {
  return z
    .object({
      payload: SyncEvent.payloads({ include: options?.syncEventTypes }),
    })
    .meta({
      ref: "SyncEvent",
    })
}
