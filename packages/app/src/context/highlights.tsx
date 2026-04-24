import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Locale, useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { persisted } from "@/utils/persist"
import { DialogReleaseNotes, type Highlight } from "@/components/dialog-release-notes"

const CHANGELOG_URL = "https://api.github.com/repos/Astro-Han/pawwork/releases"

type Store = {
  version?: string
}

type ParsedRelease = {
  tag?: string
  highlights: Highlight[]
}

type ReleaseLocale = Locale

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

function parseMedia(value: unknown, alt: string): Highlight["media"] | undefined {
  if (!isRecord(value)) return
  const type = getText(value.type)?.toLowerCase()
  const src = getText(value.src) ?? getText(value.url)
  if (!src) return
  if (type !== "image" && type !== "video") return

  return { type, src, alt }
}

function parseHighlight(value: unknown): Highlight | undefined {
  if (!isRecord(value)) return

  const title = getText(value.title)
  if (!title) return

  const description = getText(value.description) ?? getText(value.shortDescription)
  if (!description) return

  const media = parseMedia(value.media, title)
  return { title, description, media }
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

function summarizeNotice(notice: string | undefined): string | undefined {
  if (!notice) return

  const lines = notice
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
  if (lines.length === 0) return
  const first = lines[0].replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "")
  return first.length > 200 ? first.slice(0, 200).trimEnd() + "…" : first
}

function summarizeReleaseBody(body: string, locale: ReleaseLocale) {
  if (locale === "zh") {
    const chinese = summarizeNotice(findChineseUpdateNotice(body))
    if (chinese) return chinese
  }
  return summarizeNotice(findAppUpdateNotice(body))
}

function releaseTitle(tag: string, locale: ReleaseLocale) {
  return `${locale === "zh" ? "爪印" : "PawWork"} ${tag}`
}

function parseRelease(value: unknown, locale: ReleaseLocale): ParsedRelease | undefined {
  if (!isRecord(value)) return
  const tag = getText(value.tag) ?? getText(value.tag_name) ?? getText(value.name)

  if (Array.isArray(value.highlights)) {
    const highlights = value.highlights.flatMap((group) => {
      if (!isRecord(group)) return []

      const source = getText(group.source)
      if (!source) return []
      if (!source.toLowerCase().includes("desktop")) return []

      if (Array.isArray(group.items)) {
        return group.items.map((item) => parseHighlight(item)).filter((item): item is Highlight => item !== undefined)
      }

      const item = parseHighlight(group)
      if (!item) return []
      return [item]
    })

    return { tag, highlights }
  }

  const body = getText(value.body)
  if (tag && body) {
    const summary = summarizeReleaseBody(body, locale)
    if (summary) {
      return {
        tag,
        highlights: [{ title: releaseTitle(tag, locale), description: summary }],
      }
    }
  }

  return { tag, highlights: [] }
}

function parseChangelog(value: unknown, locale: ReleaseLocale): ParsedRelease[] | undefined {
  if (Array.isArray(value)) {
    return value
      .map((release) => parseRelease(release, locale))
      .filter((release): release is ParsedRelease => release !== undefined)
  }

  if (!isRecord(value)) return
  if (!Array.isArray(value.releases)) return

  return value.releases
    .map((release) => parseRelease(release, locale))
    .filter((release): release is ParsedRelease => release !== undefined)
}

function sliceHighlights(input: { releases: ParsedRelease[]; current?: string; previous?: string }) {
  const current = normalizeVersion(input.current)
  const previous = normalizeVersion(input.previous)
  const releases = input.releases

  const start = (() => {
    if (!current) return 0
    const index = releases.findIndex((release) => normalizeVersion(release.tag) === current)
    return index === -1 ? 0 : index
  })()

  const end = (() => {
    if (!previous) return releases.length
    const index = releases.findIndex((release, i) => i >= start && normalizeVersion(release.tag) === previous)
    return index === -1 ? releases.length : index
  })()

  const highlights = releases.slice(start, end).flatMap((release) => release.highlights)
  const seen = new Set<string>()
  const unique = highlights.filter((highlight) => {
    const key = dedupeKey(highlight)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique.slice(0, 5)
}

function dedupeKey(highlight: Highlight) {
  return [highlight.title, highlight.description, highlight.media?.type ?? "", highlight.media?.src ?? ""].join("\n")
}

export function loadReleaseHighlights(value: unknown, current?: string, previous?: string, locale: ReleaseLocale = "en") {
  const releases = parseChangelog(value, locale)
  if (!releases?.length) return []
  return sliceHighlights({ releases, current, previous })
}

export const { use: useHighlights, provider: HighlightsProvider } = createSimpleContext({
  name: "Highlights",
  gate: false,
  init: () => {
    const language = useLanguage()
    const platform = usePlatform()
    const dialog = useDialog()
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
          // GitHub returns 403 (rate limit) or 304 (etag-hit) under normal load;
          // keep the failure visible in devtools instead of silently dropping it.
          console.warn("[highlights] changelog fetch failed", response.status)
          return undefined
        })
        .then((json) => {
          if (!json) return
          const highlights = loadReleaseHighlights(json, platform.version, previous, language.locale())
          if (controller.signal.aborted) return

          if (highlights.length === 0) {
            markSeen()
            return
          }

          timer = setTimeout(() => {
            timer = undefined
            markSeen()
            dialog.show(() => <DialogReleaseNotes highlights={highlights} />)
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
