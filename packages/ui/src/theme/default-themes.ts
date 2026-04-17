import type { DesktopTheme } from "./types"
import pawworkThemeJson from "./themes/pawwork.json"

export const pawworkTheme = pawworkThemeJson as DesktopTheme

export const DEFAULT_THEMES: Record<string, DesktopTheme> = {
  pawwork: pawworkTheme,
}
