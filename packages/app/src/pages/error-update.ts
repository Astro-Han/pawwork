import type { UpdateInfo } from "@/context/platform"

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export function updateErrorPageState(result: UpdateInfo, t: Translator) {
  switch (result.status) {
    case "ready":
      return {
        version: result.version,
        actionError: undefined,
        actionMessage: undefined,
      }
    case "busy":
      return {
        version: undefined,
        actionError: undefined,
        actionMessage: t("error.page.action.busy"),
      }
    case "disabled":
      return {
        version: undefined,
        actionError: undefined,
        actionMessage: t("error.page.action.disabled"),
      }
    case "failed":
      return {
        version: undefined,
        actionError: result.message || t("error.page.action.checkFailed"),
        actionMessage: undefined,
      }
    case "none":
      return {
        version: undefined,
        actionError: undefined,
        actionMessage: t("error.page.action.upToDate"),
      }
    default: {
      const exhaustive: never = result
      return exhaustive
    }
  }
}
