import crypto from "crypto"

export namespace MemoryFile {
  export type Scope = "user" | "project"
  export type SafeModeReason =
    | "missing_profile"
    | "missing_archive"
    | "duplicate_profile"
    | "duplicate_archive"
    | "sections_out_of_order"

  export type Entry = {
    id: string
    createdAt: string
    scope: Scope
    appliesTo?: string
    heading: string
    body: string
    raw: string
  }

  export type InvalidEntry = {
    heading: string
    raw: string
    reason: string
  }

  export type ParseResult =
    | {
        status: "ok"
        profile: string
        archive: string
        entries: Entry[]
        invalidEntries: InvalidEntry[]
        profileTooLarge: boolean
      }
    | { status: "safe_mode"; reason: SafeModeReason }

  const PROFILE_HEADING = "## Profile"
  const ARCHIVE_HEADING = "## Archive"
  export const PROFILE_CONTEXT_LIMIT = 2_000

  export function defaultTemplate() {
    return [
      "# PawWork Memory",
      "",
      PROFILE_HEADING,
      "",
      "- PawWork Memory is enabled.",
      "",
      ARCHIVE_HEADING,
      "",
    ].join("\n")
  }

  export function makeID() {
    return `mem_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
  }

  export function parse(input: string): ParseResult {
    const profileMatches = [...input.matchAll(/^## Profile\s*$/gm)]
    const archiveMatches = [...input.matchAll(/^## Archive\s*$/gm)]
    if (profileMatches.length === 0) return { status: "safe_mode", reason: "missing_profile" }
    if (archiveMatches.length === 0) return { status: "safe_mode", reason: "missing_archive" }
    if (profileMatches.length > 1) return { status: "safe_mode", reason: "duplicate_profile" }
    if (archiveMatches.length > 1) return { status: "safe_mode", reason: "duplicate_archive" }

    const profileStart = profileMatches[0]!.index!
    const archiveStart = archiveMatches[0]!.index!
    if (archiveStart < profileStart) return { status: "safe_mode", reason: "sections_out_of_order" }

    const profileBodyStart = nextLineIndex(input, profileStart)
    const archiveBodyStart = nextLineIndex(input, archiveStart)
    const profile = input.slice(profileBodyStart, archiveStart).trim()
    const archive = input.slice(archiveBodyStart).trim()
    const { entries, invalidEntries } = parseEntries(archive)
    return {
      status: "ok",
      profile,
      archive,
      entries,
      invalidEntries,
      profileTooLarge: profile.length > PROFILE_CONTEXT_LIMIT,
    }
  }

  export function formatEntry(input: {
    id?: string
    createdAt?: string
    scope: Scope
    appliesTo?: string
    text: string
  }) {
    const id = input.id ?? makeID()
    const createdAt = input.createdAt ?? new Date().toISOString()
    const scope = input.scope === "project" ? `scope:project applies_to:${encodeURIComponent(input.appliesTo ?? "")}` : "scope:user"
    return `### ${createdAt} id:${id} ${scope}\n${input.text.trim()}\n`
  }

  function nextLineIndex(input: string, start: number) {
    const offset = input.slice(start).indexOf("\n")
    return offset === -1 ? input.length : start + offset + 1
  }

  function parseEntries(archive: string): { entries: Entry[]; invalidEntries: InvalidEntry[] } {
    const headingPattern = /^### \d{4}-\d{2}-\d{2}T[^\n]*\bid:[^\s]+[^\n]*$/gm
    const headings = [...archive.matchAll(headingPattern)]
    const chunks = headings
      .map((match, index) => archive.slice(match.index!, headings[index + 1]?.index ?? archive.length))
      .map((chunk) => chunk.trim())
      .filter(Boolean)
    const seen = new Set<string>()
    const entries: Entry[] = []
    const invalidEntries: InvalidEntry[] = []

    for (const raw of chunks) {
      const [heading = "", ...bodyLines] = raw.split("\n")
      if (!heading.startsWith("### ")) continue
      const parsed = parseHeading(heading)
      if (!parsed.ok) {
        invalidEntries.push({ heading, raw, reason: parsed.reason })
        continue
      }
      if (seen.has(parsed.entry.id)) {
        invalidEntries.push({ heading, raw, reason: "duplicate_id" })
        continue
      }
      seen.add(parsed.entry.id)
      const body = bodyLines.join("\n").trim()
      entries.push({ ...parsed.entry, heading, body, raw })
    }

    return { entries, invalidEntries }
  }

  function parseHeading(
    heading: string,
  ): { ok: true; entry: Omit<Entry, "body" | "raw"> } | { ok: false; reason: string } {
    const rest = heading.slice(4).trim()
    const [createdAt, ...tokens] = rest.split(/\s+/)
    if (!createdAt || Number.isNaN(Date.parse(createdAt))) return { ok: false, reason: "invalid_timestamp" }
    const meta = Object.fromEntries(
      tokens.map((token) => {
        const index = token.indexOf(":")
        return index === -1 ? [token, ""] : [token.slice(0, index), token.slice(index + 1)]
      }),
    )
    const id = meta.id
    if (!id) return { ok: false, reason: "missing_id" }
    if (meta.scope !== "user" && meta.scope !== "project") return { ok: false, reason: "invalid_scope" }
    if (meta.scope === "project" && !meta.applies_to) return { ok: false, reason: "missing_applies_to" }

    const appliesTo = meta.applies_to
      ? (() => {
          try {
            return decodeURIComponent(meta.applies_to)
          } catch {
            return meta.applies_to
          }
        })()
      : undefined

    return {
      ok: true,
      entry: {
        id,
        createdAt,
        scope: meta.scope,
        appliesTo,
        heading,
      },
    }
  }
}
