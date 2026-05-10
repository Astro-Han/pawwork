export namespace MemoryFile {
  export type SafeModeReason =
    | "missing_profile"
    | "missing_archive"
    | "duplicate_profile"
    | "duplicate_archive"
    | "sections_out_of_order"

  export type ParseResult =
    | {
        status: "ok"
        profile: string
        archive: string
        profileTooLarge: boolean
      }
    | { status: "safe_mode"; reason: SafeModeReason }

  export type ProfileOnlyParseResult =
    | {
        status: "ok"
        profile: string
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

  export function parse(input: string): ParseResult {
    const sections = parseSections(input)
    if (sections.status === "safe_mode") return sections

    const { profileStart, archiveStart } = sections
    const profileBodyStart = nextLineIndex(input, profileStart)
    const archiveBodyStart = nextLineIndex(input, archiveStart)
    const profile = input.slice(profileBodyStart, archiveStart).trim()
    const archive = input.slice(archiveBodyStart).trim()
    return {
      status: "ok",
      profile,
      archive,
      profileTooLarge: profile.length > PROFILE_CONTEXT_LIMIT,
    }
  }

  export function parseProfileOnly(input: string): ProfileOnlyParseResult {
    const sections = parseSections(input)
    if (sections.status === "safe_mode") return sections

    const profileBodyStart = nextLineIndex(input, sections.profileStart)
    const profile = input.slice(profileBodyStart, sections.archiveStart).trim()
    return {
      status: "ok",
      profile,
      profileTooLarge: profile.length > PROFILE_CONTEXT_LIMIT,
    }
  }

  function parseSections(input: string):
    | {
        status: "ok"
        profileStart: number
        archiveStart: number
      }
    | { status: "safe_mode"; reason: SafeModeReason } {
    const profileMatches = [...input.matchAll(/^## Profile\s*$/gm)]
    const archiveMatches = [...input.matchAll(/^## Archive\s*$/gm)]
    if (profileMatches.length === 0) return { status: "safe_mode", reason: "missing_profile" }
    if (archiveMatches.length === 0) return { status: "safe_mode", reason: "missing_archive" }
    if (profileMatches.length > 1) return { status: "safe_mode", reason: "duplicate_profile" }
    if (archiveMatches.length > 1) return { status: "safe_mode", reason: "duplicate_archive" }

    const profileStart = profileMatches[0]!.index!
    const archiveStart = archiveMatches[0]!.index!
    if (archiveStart < profileStart) return { status: "safe_mode", reason: "sections_out_of_order" }
    return { status: "ok", profileStart, archiveStart }
  }

  function nextLineIndex(input: string, start: number) {
    const offset = input.slice(start).indexOf("\n")
    return offset === -1 ? input.length : start + offset + 1
  }
}
