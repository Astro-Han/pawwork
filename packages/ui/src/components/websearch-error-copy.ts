import type { UiI18n } from "../context/i18n"

type WebSearchFailureKind = "invalid_key" | "quota_exceeded" | "network" | "unknown"
type WebSearchFailureSource = "anonymous" | "saved" | "env"

type WebSearchFailure = {
  kind: WebSearchFailureKind
  source?: WebSearchFailureSource
}

export type WebSearchErrorDisplay = {
  subtitle: string
  error: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function failure(metadata: unknown): WebSearchFailure | undefined {
  const webSearch = record(record(metadata)?.webSearch)
  const raw = record(webSearch?.failure)
  if (!raw) return

  const kind = raw.kind
  const source = raw.source
  const normalizedKind: WebSearchFailureKind =
    kind === "invalid_key" || kind === "quota_exceeded" || kind === "network" || kind === "unknown"
      ? kind
      : "unknown"
  const normalizedSource: WebSearchFailureSource | undefined =
    source === "anonymous" || source === "saved" || source === "env" ? source : undefined

  return { kind: normalizedKind, source: normalizedSource }
}

export function webSearchErrorDisplay(metadata: unknown, i18n: Pick<UiI18n, "t">): WebSearchErrorDisplay | undefined {
  const item = failure(metadata)
  if (!item) return

  if (item.kind === "quota_exceeded") {
    const source = item.source ?? "unknown"
    return {
      subtitle: i18n.t("ui.tool.websearch.failure.quota.title"),
      error: i18n.t(`ui.tool.websearch.failure.quota.${source}`),
    }
  }

  if (item.kind === "invalid_key") {
    const source = item.source ?? "unknown"
    return {
      subtitle: i18n.t("ui.tool.websearch.failure.invalidKey.title"),
      error: i18n.t(`ui.tool.websearch.failure.invalidKey.${source}`),
    }
  }

  if (item.kind === "network") {
    return {
      subtitle: i18n.t("ui.tool.websearch.failure.network.title"),
      error: i18n.t("ui.tool.websearch.failure.network"),
    }
  }

  return {
    subtitle: i18n.t("ui.tool.websearch.failure.unknown.title"),
    error: i18n.t("ui.tool.websearch.failure.unknown"),
  }
}
