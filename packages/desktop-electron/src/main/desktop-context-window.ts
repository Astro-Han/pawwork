import type { BrowserWindow } from "electron"
import { desktopWindowTitle } from "@opencode-ai/app/desktop-api"
import type { DesktopContext } from "../preload/types"
import type { MenuLocale } from "./menu-labels"

export function normalizeDesktopContextPayload(context: unknown, fallbackLocale: MenuLocale): DesktopContext {
  const value = context && typeof context === "object" ? (context as Record<string, unknown>) : {}
  const locale = value.locale === "zh" ? "zh" : value.locale === "en" ? "en" : fallbackLocale

  return {
    directory: typeof value.directory === "string" ? value.directory : null,
    sessionID: typeof value.sessionID === "string" ? value.sessionID : null,
    route: typeof value.route === "string" && value.route.length > 0 ? value.route : "/",
    locale,
    title: desktopWindowTitle(locale),
  }
}

export function syncWindowTitleForDesktopContext(
  win: Pick<BrowserWindow, "setTitle">,
  context: Pick<DesktopContext, "title">,
) {
  win.setTitle(context.title)
}
