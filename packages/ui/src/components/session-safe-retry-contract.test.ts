import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"

const retry = readFileSync(new URL("./session-retry.tsx", import.meta.url), "utf8")
const notice = readFileSync(new URL("./message-part/parts/notice.tsx", import.meta.url), "utf8")
const en = readFileSync(new URL("../i18n/en.ts", import.meta.url), "utf8")
const zh = readFileSync(new URL("../i18n/zh.ts", import.meta.url), "utf8")
const zht = readFileSync(new URL("../i18n/zht.ts", import.meta.url), "utf8")
const i18nDir = new URL("../i18n/", import.meta.url)
const localeFiles = Object.fromEntries(
  readdirSync(i18nDir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => [file, readFileSync(new URL(file, i18nDir), "utf8")]),
)

test("recovery retry uses a lightweight status row instead of the error card", () => {
  expect(retry).toContain('presentation !== "recovery" && current?.presentation !== "safe_recovery"')
  expect(retry).toContain('data-slot="session-turn-safe-retry"')
  expect(retry).toContain('data-slot="session-turn-safe-retry-message"')
  expect(retry).toContain('i18n.t("ui.sessionTurn.retry.recovery")')
  expect(retry).toContain('fallback={')
  expect(retry).toContain('<Card variant="error" class="error-card">')
})

test("safe retry failure renders a titled notice that adapts to a prior tool side effect", () => {
  expect(notice).toContain('registerPartComponent("notice"')
  expect(notice).toContain('part().kind === "safe_retry_failed"')
  expect(notice).toContain('data-kind="safe_retry_failed"')
  // Separated, calm presentation (#1358): a stroked status icon + ink title,
  // not the old weak single-line caption.
  expect(notice).toContain('data-variant=')
  expect(notice).toContain('<Icon name="warning"')
  expect(notice).toContain('data-slot="notice-title"')
  expect(notice).toContain('data-slot="notice-body"')
  // Adaptive copy: a completed *side-effecting* tool earlier in the turn means
  // an external action already landed, so the user must not be nudged to redo
  // it. Read-only tools (read/grep/...) must NOT trigger the reassurance — that
  // would falsely claim an action landed — so the predicate excludes them.
  expect(notice).toContain('p.type === "tool" && p.state.status === "completed" && !READ_ONLY_TOOLS.has(p.tool)')
  expect(notice).toContain('const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "webfetch", "tool_info"])')
  expect(notice).toContain("ui.sessionTurn.notice.safeRetryFailed.sideEffect.title")
  expect(notice).toContain("ui.sessionTurn.notice.safeRetryFailed.sideEffect.body")
  expect(notice).toContain("ui.sessionTurn.notice.safeRetryFailed.default.title")
  expect(notice).toContain("ui.sessionTurn.notice.safeRetryFailed.default.body")
  // The old weak caption is gone.
  expect(notice).not.toContain('class="text-caption text-fg-weak"')
})

test("safe-retry notice copy names an external cause and a next step, without nudging a redo", () => {
  // Side-effect case reassures the action already ran; default case does not
  // claim an action happened. Both attribute the failure outside PawWork and
  // give a next step.
  expect(en).toContain('"ui.sessionTurn.notice.safeRetryFailed.sideEffect.title": "Action completed"')
  expect(en).toContain('"ui.sessionTurn.notice.safeRetryFailed.default.title": "Reply incomplete"')
  expect(en).toMatch(/already went through[\s\S]*network or model provider[\s\S]*switch models/)

  expect(zh).toContain('"ui.sessionTurn.notice.safeRetryFailed.sideEffect.title": "操作已完成"')
  expect(zh).toContain('"ui.sessionTurn.notice.safeRetryFailed.default.title": "回复未完成"')
  expect(zh).toMatch(/上一项操作已执行[\s\S]*网络或模型服务商[\s\S]*请稍后重试，或换一个模型/)
  expect(zh).toMatch(/模型回复未能生成[\s\S]*网络或模型服务商/)

  expect(zht).toContain('"ui.sessionTurn.notice.safeRetryFailed.sideEffect.title": "操作已完成"')
  expect(zht).toContain('"ui.sessionTurn.notice.safeRetryFailed.default.title": "回覆未完成"')
  expect(zht).toMatch(/網路或模型服務商/)
})

test("the old single safe-retry notice key is gone everywhere", () => {
  // Split into sideEffect/default title+body; the runtime locales (en, zh) carry
  // the split copy, other locale files fall back to en, and the old flat key is
  // removed so no stale string lingers.
  for (const [path, source] of Object.entries(localeFiles)) {
    expect(source, path).not.toContain('"ui.sessionTurn.notice.safeRetryFailed":')
    expect(source, path).not.toContain("Network connection dropped. Automatic retry did not complete.")
  }
  for (const variant of ["sideEffect", "default"] as const) {
    for (const slot of ["title", "body"] as const) {
      const key = `"ui.sessionTurn.notice.safeRetryFailed.${variant}.${slot}":`
      expect(en, "en").toContain(key)
      expect(zh, "zh").toContain(key)
    }
  }
})
