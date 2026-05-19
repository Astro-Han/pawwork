/**
 * Mention metadata: capture resolved @-mention information at edit time and
 * re-validate it at submit time.
 *
 * Safety contract: resolveCommentMentions returns [] when metadata is undefined
 * or empty — there is NO free-text fallback resolve. A mention without recorded
 * metadata is silently dropped to prevent same-name cross-workspace attachment.
 */

import { checksum } from "@opencode-ai/util/encode"
import { toAbsoluteFilePath } from "./path-canonical"

export interface ResolvedMention {
  /** The visible @-token, e.g. "@src/a.ts" */
  displayText: string
  /** Absolute path computed from toAbsoluteFilePath at capture time */
  resolvedPath: string
  /**
   * Checksum of a 64-char window (32 chars on each side) centred on the
   * mention midpoint, lowercased with collapsed whitespace.  Used to detect
   * comment body drift.
   */
  fingerprint: string
  /** Inclusive char offset of the '@' in the comment string at capture time */
  start: number
  /** Exclusive char offset (start + displayText.length) */
  end: number
}

export interface CaptureMentionsInput {
  comment: string
  sourceFilesystemDirectory: string
}

export interface ResolveMentionsInput {
  comment: string
  metadata: ResolvedMention[] | undefined
}

export interface ResolvedMentionMatch {
  resolvedPath: string
}

/** Same regex as the old parseCommentMentions in build-request-parts.ts */
const MENTION_RE = /(^|[\s([{"'])@(\S+)/g

/**
 * Produce a normalized fingerprint string for a 64-char window centred at
 * `mid` inside `text`.  Lowercase + collapsed whitespace.
 */
function computeFingerprint(text: string, mid: number): string {
  const radius = 32
  const windowStart = Math.max(0, mid - radius)
  const windowEnd = Math.min(text.length, mid + radius)
  const window = text.slice(windowStart, windowEnd).toLowerCase().replace(/\s+/g, " ")
  return checksum(window) ?? window
}

/**
 * Scan `comment` for @-mentions and record resolved path + positional metadata
 * for each one.  Call this at the moment the user commits the comment text.
 */
export function captureCommentMentions(input: CaptureMentionsInput): ResolvedMention[] {
  const { comment, sourceFilesystemDirectory } = input
  const results: ResolvedMention[] = []

  for (const match of comment.matchAll(MENTION_RE)) {
    // match[1] is the preceding char (may be empty string at start of string)
    // match[2] is the raw path token
    const rawPath = (match[2] ?? "").replace(/[.,!?;:)}\]"']+$/, "")
    if (!rawPath) continue

    // The '@' sits at match.index + match[1].length
    const start = (match.index ?? 0) + (match[1]?.length ?? 0)
    const displayText = "@" + rawPath
    const end = start + displayText.length

    const resolvedPath = toAbsoluteFilePath(sourceFilesystemDirectory, rawPath)
    const mid = Math.floor((start + end) / 2)
    const fingerprint = computeFingerprint(comment, mid)

    results.push({ displayText, resolvedPath, fingerprint, start, end })
  }

  return results
}

/**
 * At submit time, validate each recorded mention against the current comment
 * body using positional matching + fingerprint drift detection.
 *
 * CRITICAL: returns [] immediately when metadata is undefined or empty.
 * There is no free-text fallback.
 */
export function resolveCommentMentions(input: ResolveMentionsInput): ResolvedMentionMatch[] {
  const { comment, metadata } = input

  if (!metadata || metadata.length === 0) return []

  const results: ResolvedMentionMatch[] = []

  for (const entry of metadata) {
    let matchStart: number | undefined

    // --- Strategy 1: range-based match ---
    if (comment.slice(entry.start, entry.end) === entry.displayText) {
      matchStart = entry.start
    } else {
      // --- Strategy 2: occurrence-based match ---
      // Count how many earlier entries in metadata share the same displayText
      // (ordered by their original start).  That count is the 0-based occurrence
      // index N we need to find in the current comment.
      const occurrenceIndex = metadata
        .filter((earlier) => earlier.displayText === entry.displayText && earlier.start < entry.start)
        .length

      let found = -1
      let searchFrom = 0
      for (let occurrence = 0; occurrence <= occurrenceIndex; occurrence++) {
        const idx = comment.indexOf(entry.displayText, searchFrom)
        if (idx === -1) {
          found = -1
          break
        }
        found = idx
        searchFrom = idx + entry.displayText.length
      }

      if (found !== -1) matchStart = found
    }

    if (matchStart === undefined) continue

    // Recompute fingerprint at the chosen location and compare
    const matchEnd = matchStart + entry.displayText.length
    const mid = Math.floor((matchStart + matchEnd) / 2)
    const currentFingerprint = computeFingerprint(comment, mid)

    if (currentFingerprint !== entry.fingerprint) continue

    results.push({ resolvedPath: entry.resolvedPath })
  }

  return results
}
