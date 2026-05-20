import { z } from "zod"
import { ProviderID } from "@/provider/schema"

export const RetryClassification = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("free_quota_exhausted"),
      providerID: ProviderID.zod,
      raw: z.string(),
      statusCode: z.number().optional(),
      retryAfterMs: z.number().optional(),
      resetAt: z.number().optional(),
    }),
    z.object({
      // "unknown" means retryable legacy classification (Kimi / Gemini / Anthropic
      // substring patches in retry.ts), NOT "unknown action". Rename to
      // `generic_retryable` whenever the broader error-classification unification
      // happens.
      kind: z.literal("unknown"),
      raw: z.string(),
      statusCode: z.number().optional(),
      retryAfterMs: z.number().optional(),
    }),
  ])
  .meta({ ref: "RetryClassification" })

export type RetryClassification = z.infer<typeof RetryClassification>

export const RetryAction = z.enum(["retry", "stop"])
export type RetryAction = z.infer<typeof RetryAction>

export function retryAction(classification: RetryClassification): RetryAction {
  if (classification.kind === "free_quota_exhausted") return "stop"
  return "retry"
}

export * as RetryClassificationModule from "./retry-classification"
