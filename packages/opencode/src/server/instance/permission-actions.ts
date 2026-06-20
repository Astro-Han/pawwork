import { Env } from "@/env"
import { Permission } from "@/permission"
import { SessionID } from "@/session/schema"
import { Effect } from "effect"
import z from "zod"

export const e2ePermissionRoutesEnabled = () =>
  Env.get("OPENCODE_E2E_ENABLED") === "true" && !!Env.get("OPENCODE_E2E_LLM_URL")

export const E2EPermissionAskBody = z.object({
  sessionID: SessionID.zod,
  permission: z.string().min(1),
  patterns: z.array(z.string()).min(1),
  metadata: z.record(z.string(), z.any()).optional(),
  always: z.array(z.string()).optional(),
})

export type E2EPermissionAskBody = z.infer<typeof E2EPermissionAskBody>

export const seedE2EPermissionAsk = Effect.fn("PermissionHttpApi.e2e.ask")(function* (json: E2EPermissionAskBody) {
  const permission = yield* Permission.Service
  yield* permission.ask({
    sessionID: json.sessionID,
    permission: json.permission,
    patterns: json.patterns,
    metadata: json.metadata ?? {},
    always: json.always ?? json.patterns,
    ruleset: [{ permission: json.permission, pattern: "*", action: "ask" }],
  })
})
