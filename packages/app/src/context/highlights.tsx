import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { type Locale, useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { persisted } from "@/utils/persist"

const CHANGELOG_URL = "https://api.github.com/repos/Astro-Han/pawwork/releases"
const MAX_RELEASE_VERSION_PAGES = 5

type Store = {
  version?: string
}

type ReleaseLocale = Locale

export type ReleaseSummary = {
  tag: string
  description: string
  localeUsed: ReleaseLocale
}

// Locale-aware copy lives here, not in i18n/{en,zh}.ts, because the toast
// title and action must follow the *parsed body's* locale, not the user's
// UI locale, when the GitHub release lacks the user's locale section
// (spec: title and description must never mix languages). @solid-primitives/i18n
// has no per-call locale override, so a small inline table is the cleanest path.
const TOAST_COPY: Record<ReleaseLocale, { title: (v: string) => string; viewFull: string }> = {
  en: { title: (v) => `Updated to ${v}`, viewFull: "Full release notes →" },
  zh: { title: (v) => `已更新到 ${v}`, viewFull: "查看完整发布说明 →" },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim()
    return text.length > 0 ? text : undefined
  }

  if (typeof value === "number") return String(value)
  return
}

function normalizeVersion(value: string | undefined) {
  const text = value?.trim()
  if (!text) return
  return text.startsWith("v") || text.startsWith("V") ? text.slice(1) : text
}

function findHeadingSection(body: string, matcher: RegExp): string | undefined {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((line) => matcher.test(line.trim()))
  if (start === -1) return

  const headingLevel = lines[start].trim().match(/^#+/)?.[0].length ?? 2
  const section = lines.slice(start + 1)
  const end = section.findIndex((line) => {
    const heading = line.trim().match(/^(#{1,6})(?:\s|$)/)
    return heading !== null && heading[1].length <= headingLevel
  })
  return (end === -1 ? section : section.slice(0, end)).join("\n")
}

function findAppUpdateNotice(body: string) {
  return findHeadingSection(body, /^#{2,6}\s+App Update Notice\s*$/i)
}

function findChineseUpdateNotice(body: string) {
  const chinese = findHeadingSection(body, /^#{2,6}\s+中文版本\s*$/)
  if (!chinese) return
  return findHeadingSection(chinese, /^#{3,6}\s+主要更新\s*$/) ?? chinese
}

function trimNoticeItem(value: string) {
  const text = value.trim()
  return text.length > 200 ? text.slice(0, 200).trimEnd() + "…" : text
}

type ParsedNotice =
  | {
      kind: "bullets"
      items: string[]
      intro?: string
    }
  | {
      kind: "summary"
      text: string
    }

function parseNoticeContent(notice: string | undefined): ParsedNotice | undefined {
  if (!notice) return

  const lines = notice
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("#"))

  const bullets: string[] = []
  const prose: string[] = []
  let currentBullet: string | undefined
  let hasSeenBullet = false

  for (const line of lines) {
    if (line.length === 0) {
      if (currentBullet) {
        bullets.push(trimNoticeItem(currentBullet))
        currentBullet = undefined
      }
      continue
    }

    const match = line.match(/^(?:[-*+]\s+|\d+\.\s+)(.+)$/)
    if (match) {
      if (currentBullet) bullets.push(trimNoticeItem(currentBullet))
      currentBullet = match[1].trim()
      hasSeenBullet = true
      continue
    }

    if (currentBullet) {
      currentBullet += ` ${line}`
    } else if (!hasSeenBullet) {
      prose.push(line)
    }
  }
  if (currentBullet) bullets.push(trimNoticeItem(currentBullet))

  if (bullets.length > 0) {
    const intro = prose.length > 0 ? trimNoticeItem(prose.join(" ")) : undefined
    return {
      kind: "bullets",
      items: bullets,
      ...(intro ? { intro } : {}),
    }
  }

  const summary = trimNoticeItem(lines.filter((line) => line.length > 0).join(" "))
  if (!summary) return

  return {
    kind: "summary",
    text: summary,
  }
}

function parseReleaseBodyNotice(
  body: string,
  locale: ReleaseLocale,
): { notice: ParsedNotice; localeUsed: ReleaseLocale } | undefined {
  if (locale === "zh") {
    const chinese = parseNoticeContent(findChineseUpdateNotice(body))
    if (chinese) return { notice: chinese, localeUsed: "zh" }
  }
  const english = parseNoticeContent(findAppUpdateNotice(body))
  return english ? { notice: english, localeUsed: "en" } : undefined
}

function formatReleaseNoticeDescription(notice: ParsedNotice) {
  if (notice.kind === "bullets") {
    const bullets = notice.items.map((item) => `• ${item}`).join("\n")
    if (notice.intro) {
      return `${notice.intro}\n${bullets}`
    }
    return bullets
  }

  return notice.text
}

// Carries the raw tag for every release in the GitHub Releases response, even
// when the body has no app-facing notice. Window-slicing must run on the full
// tag list — not the filtered summary list — otherwise a release whose body
// lacks an "App Update Notice" section silently drops out of the array, and
// `previous` may not be found, so the slice spills into older versions the
// user has already seen.
type RawRelease = { tag: string; summary: ReleaseSummary | undefined }

function parseRawRelease(value: unknown, locale: ReleaseLocale): RawRelease | undefined {
  if (!isRecord(value)) return
  const tag = getText(value.tag) ?? getText(value.tag_name) ?? getText(value.name)
  if (!tag) return

  const body = getText(value.body)
  if (!body) return { tag, summary: undefined }

  const parsed = parseReleaseBodyNotice(body, locale)
  if (!parsed) return { tag, summary: undefined }

  return {
    tag,
    summary: {
      tag,
      description: formatReleaseNoticeDescription(parsed.notice),
      localeUsed: parsed.localeUsed,
    },
  }
}

function parseChangelog(value: unknown, locale: ReleaseLocale): RawRelease[] | undefined {
  if (!Array.isArray(value)) return
  return value
    .map((release) => parseRawRelease(release, locale))
    .filter((release): release is RawRelease => release !== undefined)
}

function sliceHighlights(input: {
  releases: RawRelease[]
  current?: string
  previous?: string
}): ReleaseSummary[] {
  const current = normalizeVersion(input.current)
  const previous = normalizeVersion(input.previous)
  const startIndex = current
    ? input.releases.findIndex((r) => normalizeVersion(r.tag) === current)
    : 0
  if (startIndex === -1) return []

  const endIndex = previous
    ? input.releases.findIndex((r, i) => i >= startIndex && normalizeVersion(r.tag) === previous)
    : input.releases.length

  const sliced = input.releases.slice(startIndex, endIndex === -1 ? undefined : endIndex)
  return sliced
    .map((r) => r.summary)
    .filter((s): s is ReleaseSummary => s !== undefined)
    .slice(0, MAX_RELEASE_VERSION_PAGES)
}

export function loadReleaseHighlights(
  value: unknown,
  current?: string,
  previous?: string,
  locale: ReleaseLocale = "en",
): ReleaseSummary[] {
  const tryLocale = (lc: ReleaseLocale): ReleaseSummary[] => {
    const releases = parseChangelog(value, lc)
    if (!releases?.length) return []
    return sliceHighlights({ releases, current, previous })
  }

  const summaries = tryLocale(locale)
  if (summaries.length === 0) return summaries
  // Spec #486: title and description must never mix languages. If any
  // selected release fell back to a different locale (e.g. user is zh,
  // newest has a zh section but an older skipped release does not),
  // re-resolve the entire window in English so every segment — and the
  // toast title and action — share a single locale.
  if (summaries.some((s) => s.localeUsed !== locale)) {
    return tryLocale("en")
  }
  return summaries
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// Convert the plain-text description produced by buildToastDescription into
// minimal HTML for the toast-markdown slot. Only bullet lists and paragraphs
// are needed — the GitHub release format does not use other block elements.
function buildToastMarkdownHtml(text: string): string {
  const lines = text.split("\n")
  const result: string[] = []
  const bulletBuffer: string[] = []

  const flushBullets = () => {
    if (bulletBuffer.length > 0) {
      result.push(`<ul>${bulletBuffer.map((b) => `<li>${b}</li>`).join("")}</ul>`)
      bulletBuffer.length = 0
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === "") {
      flushBullets()
      continue
    }
    if (/^[•\-*+] /.test(trimmed)) {
      bulletBuffer.push(escapeHtml(trimmed.replace(/^[•\-*+] /, "").trim()))
    } else {
      flushBullets()
      result.push(`<p>${escapeHtml(trimmed)}</p>`)
    }
  }
  flushBullets()

  return result.join("")
}

function buildToastDescription(summaries: ReleaseSummary[], currentTag: string) {
  // First segment omits its tag only when it matches the toast title's
  // version. When summaries[0] is an older release (e.g. zh-locale fallback
  // dropped a zh-only newest release that has no English notice), the first
  // segment must carry its tag too, otherwise it reads as if the older
  // release's bullets describe the current version.
  return summaries
    .map((s, i) =>
      i === 0 && normalizeVersion(s.tag) === normalizeVersion(currentTag)
        ? s.description
        : `${s.tag}\n${s.description}`,
    )
    .join("\n\n")
}

export const { provider: HighlightsProvider } = createSimpleContext({
  name: "Highlights",
  gate: false,
  init: () => {
    const language = useLanguage()
    const platform = usePlatform()
    const settings = useSettings()
    const [store, setStore, _, ready] = persisted("highlights.v1", createStore<Store>({ version: undefined }))

    const [range, setRange] = createStore({
      from: undefined as string | undefined,
      to: undefined as string | undefined,
    })
    const state = { started: false }
    let timer: ReturnType<typeof setTimeout> | undefined

    const clearTimer = () => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }

    const markSeen = () => {
      if (!platform.version) return
      setStore("version", platform.version)
    }

    const start = (previous: string) => {
      if (!settings.general.releaseNotes()) {
        markSeen()
        return
      }

      const fetcher = platform.fetch ?? fetch
      const controller = new AbortController()
      onCleanup(() => {
        controller.abort()
        clearTimer()
      })

      fetcher(CHANGELOG_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      })
        .then((response) => {
          if (response.ok) return response.json() as Promise<unknown>
          console.warn("[highlights] changelog fetch failed", response.status)
          return undefined
        })
        .then((json) => {
          if (!json) return
          const summaries = loadReleaseHighlights(json, platform.version, previous, language.locale())
          if (controller.signal.aborted) return

          if (summaries.length === 0) {
            markSeen()
            return
          }

          // Defer 500ms so the toast region has mounted and the splash has
          // settled before the toast slides in — avoids a visual collision
          // on first launch after an update.
          timer = setTimeout(() => {
            timer = undefined
            // Title and link always anchor on the app's current version,
            // not summaries[0].tag. The two diverge when the current
            // release has no notice in the resolved locale (e.g. zh user,
            // newest release has only a 中文版本 section, an older skipped
            // release has only English; English rebuild drops the newest
            // release and summaries[0] becomes the older one).
            const currentTag = `v${platform.version}`
            const copy = TOAST_COPY[summaries[0].localeUsed]
            const url = `https://github.com/Astro-Han/pawwork/releases/tag/${currentTag}`

            showToast({
              title: copy.title(currentTag),
              markdownHtml: buildToastMarkdownHtml(buildToastDescription(summaries, currentTag)),
              icon: "bullet-list",
              variant: "subtle",
              persistent: true,
              actions: [
                {
                  label: copy.viewFull,
                  onClick: () => platform.openLink(url),
                },
              ],
              onDismiss: markSeen,
            })
          }, 500)
        })
        .catch(() => undefined)
    }

    createEffect(() => {
      if (state.started) return
      if (!ready()) return
      if (!settings.ready()) return
      if (!platform.version) return
      state.started = true

      const previous = store.version
      if (!previous) {
        setStore("version", platform.version)
        return
      }

      if (previous === platform.version) return

      setRange({ from: previous, to: platform.version })
      start(previous)
    })

    return {
      ready,
      from: () => range.from,
      to: () => range.to,
      get last() {
        return store.version
      },
      markSeen,
    }
  },
})
