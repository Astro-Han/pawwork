import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const retry = readFileSync(new URL("./session-retry.tsx", import.meta.url), "utf8")
const notice = readFileSync(new URL("./message-part/parts/notice.tsx", import.meta.url), "utf8")
const en = readFileSync(new URL("../i18n/en.ts", import.meta.url), "utf8")
const zh = readFileSync(new URL("../i18n/zh.ts", import.meta.url), "utf8")
const zht = readFileSync(new URL("../i18n/zht.ts", import.meta.url), "utf8")

test("recovery retry uses a lightweight status row instead of the error card", () => {
  expect(retry).toContain('presentation !== "recovery" && current?.presentation !== "safe_recovery"')
  expect(retry).toContain('data-slot="session-turn-safe-retry"')
  expect(retry).toContain('data-slot="session-turn-safe-retry-message"')
  expect(retry).toContain('i18n.t("ui.sessionTurn.retry.recovery")')
  expect(retry).toContain('fallback={')
  expect(retry).toContain('<Card variant="error" class="error-card">')
})

test("safe retry failure renders as a dedicated notice part", () => {
  expect(notice).toContain('registerPartComponent("notice"')
  expect(notice).toContain('part().kind === "safe_retry_failed"')
  expect(notice).toContain('data-kind="safe_retry_failed"')
  expect(notice).toContain('i18n.t("ui.sessionTurn.notice.safeRetryFailed")')
})

test("recovery copy stays short and non-technical in English and Chinese", () => {
  expect(en).toContain('"ui.sessionTurn.retry.recovery": "Recovering..."')
  expect(en).toContain(
    '"ui.sessionTurn.notice.safeRetryFailed": "Recovery failed. Try again later or switch models."',
  )
  expect(zh).toContain('"ui.sessionTurn.retry.recovery": "正在恢复…"')
  expect(zh).toContain('"ui.sessionTurn.notice.safeRetryFailed": "恢复失败。你可以稍后再试，或换一个模型。"')
  expect(zht).toContain('"ui.sessionTurn.retry.recovery": "正在恢復…"')
  expect(zht).toContain('"ui.sessionTurn.notice.safeRetryFailed": "恢復失敗。你可以稍後再試，或換一個模型。"')
})
