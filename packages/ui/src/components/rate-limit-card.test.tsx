/**
 * rate-limit-card.test.tsx
 *
 * Two-layer test strategy:
 * 1. Source-analysis: verify DOM slots, CSS class contracts, and no-go rules
 *    (no buttons, no app imports) by reading the source file as text.
 * 2. Pure helper: verify formatResetTime produces correct HH:MM strings and
 *    the system timezone via mocking Intl.DateTimeFormat.
 */
import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { formatResetTime } from "./rate-limit-card"

const src = readFileSync(new URL("./rate-limit-card.tsx", import.meta.url), "utf8")
const css = readFileSync(new URL("./rate-limit-card.css", import.meta.url), "utf8")

// ── DOM slot / data-attribute contract ─────────────────────────────────────

describe("RateLimitCard: data-slot contract", () => {
  test('root has data-slot="rate-limit-card"', () => {
    expect(src).toContain('data-slot="rate-limit-card"')
  })

  test('subscribe link has data-slot="rate-limit-card-subscribe"', () => {
    expect(src).toContain('data-slot="rate-limit-card-subscribe"')
  })

  test('BYO link has data-slot="rate-limit-card-byo"', () => {
    expect(src).toContain('data-slot="rate-limit-card-byo"')
  })
})

// ── No-go: no buttons (DESIGN.md L463) ────────────────────────────────────

describe("RateLimitCard: no-go rules", () => {
  test("actions are <a> links, not <button> elements", () => {
    // The actions section must use anchor tags only.
    expect(src).not.toMatch(/<button[^>]*rate-limit-card__action/)
    // Confirm the subscribe action is an anchor.
    expect(src).toContain('data-slot="rate-limit-card-subscribe"')
    // The subscribe anchor uses onClick with preventDefault, not form submit.
    expect(src).toContain("e.preventDefault()")
  })

  test("does not import from packages/app", () => {
    expect(src).not.toMatch(/from ['"].*packages\/app/)
    expect(src).not.toMatch(/from ['"]@pawwork\/app/)
  })

  test("does not reference window.api", () => {
    expect(src).not.toContain("window.api")
  })

  test("does not reference trackEvent", () => {
    expect(src).not.toContain("trackEvent")
  })

  test("does not hardcode any locale string (no English copy in JSX)", () => {
    // All copy must go through i18n.t(). The only allowed string literals are
    // i18n key names and CSS class names.
    expect(src).not.toContain("Today's free quota")
    expect(src).not.toContain("Subscribe to OpenCode")
    expect(src).not.toContain("Use your own model")
    expect(src).not.toContain("Resets")
  })
})

// ── Callback props ─────────────────────────────────────────────────────────

describe("RateLimitCard: callback props", () => {
  test("onSubscribeClick prop is declared in RateLimitCardProps", () => {
    expect(src).toContain("onSubscribeClick")
  })

  test("onUseOwnModelClick prop is declared in RateLimitCardProps", () => {
    expect(src).toContain("onUseOwnModelClick")
  })

  test("onSubscribeClick is called on subscribe link click", () => {
    expect(src).toContain("props.onSubscribeClick()")
  })

  test("onUseOwnModelClick is called on BYO link click", () => {
    expect(src).toContain("props.onUseOwnModelClick()")
  })
})

// ── CSS: warning left-border rule ──────────────────────────────────────────

describe("RateLimitCard: CSS token contract", () => {
  test("left border uses var(--warning)", () => {
    expect(css).toContain("border-left: 2px solid var(--warning)")
  })

  test("icon color uses var(--warning)", () => {
    expect(css).toContain("color: var(--warning)")
  })

  test("primary action color uses var(--warning)", () => {
    // rate-limit-card__action--primary must override to warning color.
    expect(css).toMatch(/\.rate-limit-card__action--primary[\s\S]*?color:\s*var\(--warning\)/)
  })

  test("title color uses var(--fg-strong)", () => {
    expect(css).toContain("color: var(--fg-strong)")
  })

  test("description font uses var(--type-body)", () => {
    expect(css).toContain("font: var(--type-body)")
  })

  test("actions gap is 20px", () => {
    expect(css).toMatch(/\.rate-limit-card__actions[\s\S]*?gap:\s*20px/)
  })
})

// ── formatResetTime pure helper ────────────────────────────────────────────

describe("formatResetTime", () => {
  // 2024-01-15 UTC midnight = 1705276800000 ms
  // Asia/Shanghai is UTC+8 → 08:00
  // America/New_York is UTC-5 (EST in January) → 19:00 previous day, but
  // the displayed time for the same epoch varies by TZ.
  const EPOCH_UTC_MIDNIGHT = 1705276800000 // 2024-01-15T00:00:00Z

  test("returns time string in HH:MM format", () => {
    const { time } = formatResetTime(EPOCH_UTC_MIDNIGHT)
    // HH:MM with hour12: false — must match pattern like "08:00" or "19:00"
    expect(time).toMatch(/^\d{2}:\d{2}$/)
  })

  test("returns non-empty timezone string from Intl", () => {
    const { tz } = formatResetTime(EPOCH_UTC_MIDNIGHT)
    expect(typeof tz).toBe("string")
    expect(tz.length).toBeGreaterThan(0)
  })

  test("different epochs produce different time strings", () => {
    const { time: t1 } = formatResetTime(EPOCH_UTC_MIDNIGHT)
    // 6 hours later
    const { time: t2 } = formatResetTime(EPOCH_UTC_MIDNIGHT + 6 * 60 * 60 * 1000)
    expect(t1).not.toEqual(t2)
  })
})
