/**
 * rate-limit-card.test.tsx
 *
 * Two-layer test strategy:
 * 1. Source-analysis: verify DOM slots, CSS class contracts, and no-go rules
 *    (no buttons, no app imports) by reading the source file as text.
 * 2. Pure helper: verify formatResetTime produces correct HH:MM strings.
 */
import { describe, expect, test } from "bun:test"
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

// ── Architecture: composes the canonical Card primitive ───────────────────
//
// PR #775 originally hand-rolled every visual rule (left border, title weight,
// description color, body gap) instead of leaning on `<Card variant="warning">`.
// That bypassed the project token system and led to off-grid spacing, an
// undefined `--fg-muted` token, and a line-height that matched no type token.
// These tests pin the architecture so the same drift cannot reappear.

describe("RateLimitCard: composes Card primitive", () => {
  test("imports Card / CardTitle / CardDescription / CardActions from ./card", () => {
    expect(src).toMatch(/from\s+['"]\.\/card['"]/)
    expect(src).toContain("Card")
    expect(src).toContain("CardTitle")
    expect(src).toContain("CardDescription")
    expect(src).toContain("CardActions")
  })

  test("renders <Card variant=\"warning\"> so the 2px rule and accent come from the primitive", () => {
    expect(src).toMatch(/<Card\b[^>]*variant=["']warning["']/)
  })

  test("scoped CSS targets the data-kind hook, not the bare component name", () => {
    // Mirrors the tool-error-card pattern: `[data-component="card"][data-kind="..."]`.
    expect(css).toContain('[data-component="card"][data-kind="rate-limit-card"]')
  })

  test("does not redefine container styles already owned by Card primitive", () => {
    // The left rule, title color, and description font live in card.css now.
    // Catching them here would mean RateLimitCard drifted off the system again.
    expect(css).not.toContain("border-left")
    expect(css).not.toContain("--fg-strong")
    expect(css).not.toContain("--font-size-body")
  })
})

// ── CSS: action-link specifics still live in this file ────────────────────

describe("RateLimitCard: CSS token contract", () => {
  test("primary action color uses var(--warning)", () => {
    expect(css).toMatch(/\.rate-limit-card__action--primary[\s\S]*?color:\s*var\(--warning\)/)
  })

  test("secondary action color uses var(--fg-weak), not the undefined --fg-muted", () => {
    expect(css).toContain("var(--fg-weak)")
    expect(css).not.toContain("--fg-muted")
  })

  test("actions row uses an on-grid horizontal gap via --space-* token", () => {
    expect(css).toMatch(/\[data-slot="card-actions"\][\s\S]*?gap:\s*var\(--space-/)
  })
})

// ── formatResetTime pure helper ────────────────────────────────────────────

describe("formatResetTime", () => {
  const EPOCH_UTC_MIDNIGHT = 1705276800000 // 2024-01-15T00:00:00Z
  const SIX_HOURS = 6 * 60 * 60 * 1000
  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000

  test("returns time string in HH:MM format", () => {
    // HH:MM with hour12: false — must match pattern like "08:00" or "19:00"
    expect(formatResetTime(EPOCH_UTC_MIDNIGHT).time).toMatch(/^\d{2}:\d{2}$/)
  })

  test("different epochs produce different time strings", () => {
    const t1 = formatResetTime(EPOCH_UTC_MIDNIGHT).time
    const t2 = formatResetTime(EPOCH_UTC_MIDNIGHT + SIX_HOURS).time
    expect(t1).not.toEqual(t2)
  })

  test("dayOffset is 0 when reset is on the same local calendar day as now", () => {
    // Same instant for both reset and now → identical local date components.
    expect(formatResetTime(EPOCH_UTC_MIDNIGHT, EPOCH_UTC_MIDNIGHT).dayOffset).toBe(0)
  })

  test("dayOffset is 1 when reset is past the local day boundary", () => {
    // Two days ahead is comfortably past midnight in any local timezone.
    expect(formatResetTime(EPOCH_UTC_MIDNIGHT + TWO_DAYS, EPOCH_UTC_MIDNIGHT).dayOffset).toBe(1)
  })
})
