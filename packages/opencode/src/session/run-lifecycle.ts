import { z } from "zod"
import { MessageID, SessionID } from "./schema"
import type { LifecycleOrigin, LifecycleRequest } from "./lifecycle-provenance"
import type { LifecycleKind } from "./run-observability/types"

export namespace RunLifecycle {
  export const SCHEMA_VERSION = 1

  export const Lifecycle = z.object({
    action_id: z.string(),
    kind: z.string(),
    initiated_at: z.number().optional(),
    initiated_monotonic_ms: z.number().optional(),
    affected_directory_keys: z.array(z.string()).optional(),
    origin: z.any().optional(),
    request: z.any().optional(),
  })
  export type Lifecycle = {
    action_id: string
    kind: LifecycleKind | string
    initiated_at?: number
    initiated_monotonic_ms?: number
    affected_directory_keys?: string[]
    origin?: LifecycleOrigin
    request?: LifecycleRequest
  }

  export const Event = z.object({
    schema_version: z.literal(SCHEMA_VERSION),
    type: z.string(),
    session_id: SessionID.zod,
    message_id: MessageID.zod.optional(),
    assistant_message_id: MessageID.zod.optional(),
    at: z.number(),
    duration_ms: z.number().optional(),
    reason: z.string().optional(),
    lifecycle: Lifecycle.optional(),
  })
  export type Event = {
    schema_version: typeof SCHEMA_VERSION
    type:
      | "user_message_saved"
      | "run_wait_started"
      | "run_wait_ended"
      | "assistant_message_created"
      | "model_started"
      | string
    session_id: SessionID
    message_id?: MessageID
    assistant_message_id?: MessageID
    at: number
    duration_ms?: number
    reason?: string
    lifecycle?: Lifecycle
  }

  export function lifecycleFromMeta(meta: {
    lifecycleActionID?: string
    lifecycleKind?: string
    lifecycleInitiatedAt?: number
    lifecycleInitiatedMonotonicMs?: number
    lifecycleAffectedDirectoryKeys?: string[]
    lifecycleOrigin?: LifecycleOrigin
    lifecycleRequest?: LifecycleRequest
  }): Lifecycle | undefined {
    if (!meta.lifecycleActionID || !meta.lifecycleKind) return undefined
    return {
      action_id: meta.lifecycleActionID,
      kind: meta.lifecycleKind,
      initiated_at: meta.lifecycleInitiatedAt,
      initiated_monotonic_ms: meta.lifecycleInitiatedMonotonicMs,
      affected_directory_keys: meta.lifecycleAffectedDirectoryKeys,
      origin: meta.lifecycleOrigin,
      request: meta.lifecycleRequest,
    }
  }
}
