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
    tags: string[]
    heading: string
    body: string
    source?: string
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
  const PROFILE_SOFT_LIMIT = 2_000

  export function defaultTemplate() {
    return [
      "# PawWork Memory",
      "<!-- pawwork-memory-version: 1 -->",
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
      profileTooLarge: profile.length > PROFILE_SOFT_LIMIT,
    }
  }

  export function formatEntry(input: {
    id?: string
    createdAt?: string
    scope: Scope
    appliesTo?: string
    tags?: string[]
    text: string
    source?: string
  }) {
    const id = input.id ?? makeID()
    const createdAt = input.createdAt ?? new Date().toISOString()
    const tags = input.tags?.length ? input.tags.join(",") : "memory"
    const scope = input.scope === "project" ? `scope:project applies_to:${input.appliesTo ?? ""}` : "scope:user"
    const source = input.source?.trim() ? `\n\nSource: ${input.source.trim()}` : ""
    return `### ${createdAt} id:${id} ${scope} tags:${tags}\n${input.text.trim()}${source}\n`
  }

  function nextLineIndex(input: string, start: number) {
    const offset = input.slice(start).indexOf("\n")
    return offset === -1 ? input.length : start + offset + 1
  }

  function parseEntries(archive: string): { entries: Entry[]; invalidEntries: InvalidEntry[] } {
    const chunks = archive
      .split(/\n(?=### )/)
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
      entries.push({ ...parsed.entry, heading, body, source: parseSource(body), raw })
    }

    return { entries, invalidEntries }
  }

  function parseHeading(
    heading: string,
  ): { ok: true; entry: Omit<Entry, "body" | "source" | "raw"> } | { ok: false; reason: string } {
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

    return {
      ok: true,
      entry: {
        id,
        createdAt,
        scope: meta.scope,
        appliesTo: meta.applies_to,
        tags: meta.tags ? meta.tags.split(",").filter(Boolean) : [],
        heading,
      },
    }
  }

  function parseSource(body: string) {
    return body.match(/^Source:\s*(.+)$/m)?.[1]?.trim()
  }
}
