import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const retry = readFileSync(new URL("./session-retry.tsx", import.meta.url), "utf8")
const notice = readFileSync(new URL("./message-part/parts/notice.tsx", import.meta.url), "utf8")
const en = readFileSync(new URL("../i18n/en.ts", import.meta.url), "utf8")
const zh = readFileSync(new URL("../i18n/zh.ts", import.meta.url), "utf8")
const zht = readFileSync(new URL("../i18n/zht.ts", import.meta.url), "utf8")

test("safe recovery retry uses a lightweight status row instead of the error card", () => {
  expect(retry).toContain('presentation !== "safe_recovery"')
  expect(retry).toContain('data-slot="session-turn-safe-retry"')
  expect(retry).toContain('data-slot="session-turn-safe-retry-message"')
  expect(retry).toContain('i18n.t("ui.sessionTurn.retry.safeRecovery")')
  expect(retry).toContain('fallback={')
  expect(retry).toContain('<Card variant="error" class="error-card">')
})

test("safe retry failure renders as a dedicated notice part", () => {
  expect(notice).toContain('registerPartComponent("notice"')
  expect(notice).toContain('part().kind === "safe_retry_failed"')
  expect(notice).toContain('data-kind="safe_retry_failed"')
  expect(notice).toContain('i18n.t("ui.sessionTurn.notice.safeRetryFailed")')
})

test("safe retry copy stays short and non-technical in English and Chinese", () => {
  expect(en).toContain('"ui.sessionTurn.retry.safeRecovery": "No response yet. Retrying..."')
  expect(en).toContain(
    '"ui.sessionTurn.notice.safeRetryFailed": "The model isn\'t responding right now. Try again later or switch models."',
  )
  expect(zh).toContain('"ui.sessionTurn.retry.safeRecovery": "模型暂时没有响应，正在重试…"')
  expect(zh).toContain('"ui.sessionTurn.notice.safeRetryFailed": "模型暂时没有响应。你可以稍后再试，或换一个模型。"')
  expect(zht).toContain('"ui.sessionTurn.retry.safeRecovery": "模型暫時沒有回應，正在重試…"')
  expect(zht).toContain('"ui.sessionTurn.notice.safeRetryFailed": "模型暫時沒有回應。你可以稍後再試，或換一個模型。"')
})
