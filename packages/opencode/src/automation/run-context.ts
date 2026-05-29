import { Context, Effect } from "effect"
import type { Permission } from "@/permission"
import type { PermissionID } from "@/permission/schema"

export type AutomationRunAttendance = "attended" | "unattended"

export type AutomationRunBlocker =
  | { kind: "permission"; requestID: PermissionID }
  | { kind: "question"; callID: string }

export interface AutomationRunContext {
  readonly attendance: AutomationRunAttendance
  readonly stepCap?: number
  readonly block: (blocker: AutomationRunBlocker) => Effect.Effect<void>
  readonly clear: () => Effect.Effect<void>
}

export class AutomationStepCapError extends Error {
  readonly _tag = "AutomationStepCapError"
  constructor(readonly stepCap: number) {
    super(`Automation run exceeded the hard step cap (${stepCap}).`)
    this.name = "AutomationStepCapError"
  }
}

export const AutomationRunContextService: Context.Reference<AutomationRunContext | undefined> = Context.Reference<
  AutomationRunContext | undefined
>("@opencode/AutomationRunContext", {
  defaultValue: () => undefined,
})

export const AutomationRunContext = {
  service: AutomationRunContextService,
  current: AutomationRunContextService,
  attended(input: Pick<AutomationRunContext, "block" | "clear" | "stepCap">): AutomationRunContext {
    return { attendance: "attended", ...input }
  },
  unattended(input: Pick<AutomationRunContext, "block" | "clear" | "stepCap">): AutomationRunContext {
    return { attendance: "unattended", ...input }
  },
  permissionOnPending(
    context: AutomationRunContext | undefined,
  ): ((request: Permission.Request) => Effect.Effect<void>) | undefined {
    if (!context) return undefined
    return (request) => context.block({ kind: "permission", requestID: request.id })
  },
}
