import type { UpdateInfo } from "@/context/platform"

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export function updateErrorPageState(result: UpdateInfo, t: Translator) {
  if (result.status === "ready") {
    return {
      version: result.version,
      actionError: undefined,
      actionMessage: undefined,
    }
  }

  if (result.status === "busy") {
    return {
      version: undefined,
      actionError: undefined,
      actionMessage: t("error.page.action.busy"),
    }
  }

  if (result.status === "disabled") {
    return {
      version: undefined,
      actionError: undefined,
      actionMessage: t("error.page.action.disabled"),
    }
  }

  if (result.status === "failed") {
    return {
      version: undefined,
      actionError: result.message || t("error.page.action.checkFailed"),
      actionMessage: undefined,
    }
  }

  return {
    version: undefined,
    actionError: undefined,
    actionMessage: t("error.page.action.upToDate"),
  }
}
