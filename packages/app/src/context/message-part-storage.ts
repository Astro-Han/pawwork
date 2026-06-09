import type { Part } from "@opencode-ai/sdk/v2/client"

const SKIPPED_MESSAGE_PART_TYPES = new Set<Part["type"]>(["patch", "step-start", "step-finish"])

export function shouldStoreMessagePart(part: Pick<Part, "type">) {
  return !SKIPPED_MESSAGE_PART_TYPES.has(part.type)
}
