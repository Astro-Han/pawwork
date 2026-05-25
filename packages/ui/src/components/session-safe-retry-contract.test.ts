import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const retry = readFileSync(new URL("./session-retry.tsx", import.meta.url), "utf8")
const notice = readFileSync(new URL("./message-part/parts/notice.tsx", import.meta.url), "utf8")

test("safe recovery retry uses a lightweight status row instead of the error card", () => {
  expect(retry).toContain('presentation !== "safe_recovery"')
  expect(retry).toContain('data-slot="session-turn-safe-retry"')
  expect(retry).toContain('data-slot="session-turn-safe-retry-message"')
  expect(retry).toContain('fallback={')
  expect(retry).toContain('<Card variant="error" class="error-card">')
})

test("safe retry failure renders as a dedicated notice part", () => {
  expect(notice).toContain('registerPartComponent("notice"')
  expect(notice).toContain('part().kind === "safe_retry_failed"')
  expect(notice).toContain('data-kind="safe_retry_failed"')
  expect(notice).toContain('i18n.t("ui.sessionTurn.notice.safeRetryFailed")')
})
