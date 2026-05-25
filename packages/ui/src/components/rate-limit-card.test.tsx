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

  test('DeepSeek link has data-slot="rate-limit-card-deepseek"', () => {
    expect(src).toContain('data-slot="rate-limit-card-deepseek"')
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

  test("onDeepSeekClick prop is declared in RateLimitCardProps", () => {
    expect(src).toContain("onDeepSeekClick")
  })

  test("onSubscribeClick is called on subscribe link click", () => {
    expect(src).toContain("props.onSubscribeClick()")
  })

  test("onUseOwnModelClick is called on BYO link click", () => {
    expect(src).toContain("props.onUseOwnModelClick()")
  })

  test("onDeepSeekClick is called on DeepSeek link click", () => {
    expect(src).toContain("props.onDeepSeekClick()")
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

  test('renders <Card variant="warning"> so the 2px rule and accent come from the primitive', () => {
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

// ── Live invalidation at resetAt ───────────────────────────────────────────
//
// rate_limit_blocked is a sticky terminal state (see session/status.ts), so
// the card outlives resetAt unless the user submits a new turn. The component
// schedules a one-shot tick at resetAt that flips its internal `now` signal,
// forcing formatResetTime to fall through to the no-time subtitle.

describe("RateLimitCard: invalidates copy at resetAt", () => {
  test("imports onMount, createSignal, and onCleanup from solid-js", () => {
    expect(src).toMatch(/from\s+["']solid-js["']/)
    expect(src).toContain("onMount")
    expect(src).toContain("createSignal")
    expect(src).toContain("onCleanup")
  })

  test("schedules a setTimeout whose delay is derived from resetAt minus Date.now()", () => {
    expect(src).toContain("setTimeout")
    // Delay is computed from resetAt; we don't pin the exact arithmetic but do
    // require both pieces appear in the same function so the relation is local.
    expect(src).toMatch(/resetAt\s*-\s*Date\.now\(\)/)
  })

  test("clears the scheduled timer on unmount", () => {
    expect(src).toContain("clearTimeout")
    expect(src).toMatch(/onCleanup\(\s*\(\s*\)\s*=>\s*clearTimeout/)
  })

  test("skips scheduling when resetAt is undefined or already past", () => {
    // The guard keeps the timer cost at zero for the no-time fallback path and
    // avoids a setTimeout(_, 0) thrash when the provider sent a past HTTP-date.
    expect(src).toMatch(/if\s*\(\s*resetAt\s*===\s*undefined\s*\)\s*return/)
    expect(src).toMatch(/if\s*\(\s*remaining\s*<=\s*0\s*\)\s*return/)
  })
})

// ── formatResetTime pure helper ────────────────────────────────────────────

describe("formatResetTime", () => {
  const EPOCH_UTC_MIDNIGHT = 1705276800000 // 2024-01-15T00:00:00Z
  const ONE_HOUR = 60 * 60 * 1000
  const SIX_HOURS = 6 * ONE_HOUR
  const ONE_DAY = 24 * ONE_HOUR
  const TWO_DAYS = 2 * ONE_DAY
  // ±14h is the widest real local offset, so EPOCH + 6h stays on the same
  // local calendar day in every IANA timezone.
  const NOW = EPOCH_UTC_MIDNIGHT

  test("returns time string in HH:MM format", () => {
    expect(formatResetTime(NOW + SIX_HOURS, NOW)?.time).toMatch(/^\d{2}:\d{2}$/)
  })

  test("different epochs produce different time strings", () => {
    const t1 = formatResetTime(NOW + ONE_HOUR, NOW)?.time
    const t2 = formatResetTime(NOW + SIX_HOURS, NOW)?.time
    expect(t1).not.toEqual(t2)
  })

  test("kind is 'today' when reset is later the same local calendar day", () => {
    expect(formatResetTime(NOW + SIX_HOURS, NOW)?.kind).toBe("today")
  })

  test("kind is 'tomorrow' when reset is exactly one day ahead", () => {
    expect(formatResetTime(NOW + ONE_DAY, NOW)?.kind).toBe("tomorrow")
  })

  test("returns undefined when resetAt is already past, even on the same local day", () => {
    // Past on a previous day: provider sent an HTTP-date that already elapsed
    // (retry.ts clamps the wait to 0 but writes the parsed date through).
    expect(formatResetTime(NOW - TWO_DAYS, NOW)).toBeUndefined()
    // Past within the same local day: the day-bucket check alone misses this,
    // so the card would otherwise read "Resets around HH:MM today" for a time
    // that has already gone by.
    expect(formatResetTime(NOW, NOW + SIX_HOURS)).toBeUndefined()
  })

  test("returns undefined when resetAt is more than one local day ahead", () => {
    expect(formatResetTime(NOW + TWO_DAYS, NOW)).toBeUndefined()
  })
})
