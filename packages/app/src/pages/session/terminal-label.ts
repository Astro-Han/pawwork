import { isDefaultTitle as isDefaultTerminalTitle } from "@/context/terminal-title"
import type { TerminalTabID } from "@/context/terminal-types"

type TFn = (key: string, vars?: Record<string, string | number | boolean>) => string

/**
 * Render label for a single terminal. Custom user title wins; falls back to the
 * numbered "Terminal N" pattern via i18n.
 *
 * Use `computeTerminalLabels` instead when you have multiple terminals and want
 * cwd-basename naming with same-name dedup.
 */
export const terminalTabLabel = (input: { title?: string; titleNumber?: number; t: TFn }) => {
  const title = input.title ?? ""
  const number = input.titleNumber ?? 0
  const isDefaultTitle = Number.isFinite(number) && number > 0 && isDefaultTerminalTitle(title, number)

  if (title && !isDefaultTitle) return title
  if (number > 0) return input.t("terminal.title.numbered", { number })
  if (title) return title
  return input.t("terminal.title")
}

/**
 * Last path segment of a cwd, accepting both POSIX (`/`) and Windows (`\`)
 * separators. PawWork ships on macOS and Windows; session dir comes through
 * URL params from the platform's native filesystem, so a single regex won't
 * cover both. Returns empty for drive roots (`C:\`, `/`) and UNC roots
 * (`\\server\share` collapsed to nothing meaningful) — callers then fall back
 * to the numbered/generic label.
 */
const lastPathSegment = (cwd: string): string => {
  const trimmed = cwd.replace(/[/\\]+$/u, "")
  if (!trimmed) return ""
  // After trimming trailing separators, a bare drive letter ("C:") or UNC
  // prefix ("\\\\server") has no useful basename — don't return the prefix
  // itself as the label.
  if (/^[A-Za-z]:$/u.test(trimmed)) return ""
  if (/^\\\\[^\\/]+$/u.test(trimmed)) return ""
  const sep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return sep === -1 ? trimmed : trimmed.slice(sep + 1)
}

interface TerminalForLabel {
  tabID: TerminalTabID
  title?: string
  titleNumber?: number
  cwd?: string
}

/**
 * Derive a display label per terminal tab. Order of preference per tab:
 *   1. Custom user title (rename) — wins, never deduped.
 *   2. cwd basename — same basename across multiple defaulted tabs gets
 *      sequential suffixes ("pawwork", "pawwork 2", "pawwork 3"). Renamed
 *      siblings don't consume a slot.
 *   3. i18n "Terminal N" — when cwd is missing or yields no basename
 *      (e.g. root path).
 *   4. i18n "Terminal" — last-resort when number is also 0.
 */
export const computeTerminalLabels = (
  terminals: readonly TerminalForLabel[],
  opts: { t: TFn },
): Map<TerminalTabID, string> => {
  const result = new Map<TerminalTabID, string>()
  const counts = new Map<string, number>()

  for (const term of terminals) {
    const title = term.title ?? ""
    const number = term.titleNumber ?? 0
    const isDefault =
      !title || (Number.isFinite(number) && number > 0 && isDefaultTerminalTitle(title, number))

    if (!isDefault) {
      // user renamed; respect it
      result.set(term.tabID, title)
      continue
    }

    const basename = lastPathSegment(term.cwd ?? "")
    if (basename) {
      const taken = counts.get(basename) ?? 0
      const next = taken + 1
      counts.set(basename, next)
      result.set(term.tabID, next === 1 ? basename : `${basename} ${next}`)
      continue
    }

    // no usable cwd → fall back to numbered / generic
    if (number > 0) {
      result.set(term.tabID, opts.t("terminal.title.numbered", { number }))
    } else {
      result.set(term.tabID, opts.t("terminal.title"))
    }
  }

  return result
}
