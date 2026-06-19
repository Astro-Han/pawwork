import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import z from "zod"

export function globalEventOpenApiSchema() {
  return z
    .object({
      directory: z.string(),
      project: z.string().optional(),
      workspace: z.string().optional(),
      payload: BusEvent.payloads(),
    })
    .meta({
      ref: "GlobalEvent",
    })
}

export function globalSyncEventOpenApiSchema() {
  return z
    .object({
      payload: SyncEvent.payloads(),
    })
    .meta({
      ref: "SyncEvent",
    })
}
