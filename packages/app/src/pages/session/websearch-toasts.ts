import type { Part } from "@opencode-ai/sdk/v2"

const WEBSEARCH_TOOL = "websearch"

type Failure = {
  kind?: unknown
  source?: unknown
  status?: unknown
}

export type WebSearchRecoveryToast = {
  id: string
  titleKey: "toast.websearch.quota.title" | "toast.websearch.invalidKey.title"
  descriptionKey:
    | "toast.websearch.quota.description"
    | "toast.websearch.savedQuota.description"
    | "toast.websearch.invalidKey.description"
  actionKey: "toast.websearch.action.openSettings"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

type FailureContext = {
  failure: Failure
  id: string
}

function failureFrom(part: Part): FailureContext | undefined {
  if (part.type !== "tool") return
  if (part.tool !== WEBSEARCH_TOOL) return
  if (part.state.status !== "error") return
  const partRecord = part as unknown
  if (!isRecord(partRecord)) return
  const metadata = part.state.metadata
  if (!isRecord(metadata)) return
  const webSearch = metadata.webSearch
  if (!isRecord(webSearch)) return
  const failure = webSearch.failure
  if (!isRecord(failure)) return
  const callID = partRecord.callID
  const id = typeof callID === "string" && callID ? callID : part.id
  return { failure, id }
}

export function webSearchRecoveryToast(
  part: Part,
  input: { surfaced: Set<string> },
): WebSearchRecoveryToast | undefined {
  const context = failureFrom(part)
  if (!context) return
  if (input.surfaced.has(context.id)) return

  const kind = context.failure.kind
  const source = context.failure.source
  const toast =
    kind === "quota_exceeded" && source === "anonymous"
      ? ({
          id: context.id,
          titleKey: "toast.websearch.quota.title",
          descriptionKey: "toast.websearch.quota.description",
          actionKey: "toast.websearch.action.openSettings",
        } satisfies WebSearchRecoveryToast)
      : kind === "quota_exceeded" && source === "saved"
        ? ({
            id: context.id,
            titleKey: "toast.websearch.quota.title",
            descriptionKey: "toast.websearch.savedQuota.description",
            actionKey: "toast.websearch.action.openSettings",
          } satisfies WebSearchRecoveryToast)
      : kind === "invalid_key" && source === "saved"
        ? ({
            id: context.id,
            titleKey: "toast.websearch.invalidKey.title",
            descriptionKey: "toast.websearch.invalidKey.description",
            actionKey: "toast.websearch.action.openSettings",
          } satisfies WebSearchRecoveryToast)
        : undefined
  if (!toast) return
  input.surfaced.add(context.id)
  return toast
}
