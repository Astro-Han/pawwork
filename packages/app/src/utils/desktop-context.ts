import type { Locale } from "@/context/language"

export type DesktopContext = {
  directory: string | null
  sessionID: string | null
  route: string
  locale: Locale
}

export function buildDesktopContext(input: {
  directory?: string | null
  sessionID?: string | null
  route: string
  locale: Locale
}): DesktopContext {
  return {
    directory: input.directory ?? null,
    sessionID: input.sessionID ?? null,
    route: input.route,
    locale: input.locale,
  }
}
