import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const turn = readFileSync(new URL("./session-turn.tsx", import.meta.url), "utf8")
const retry = readFileSync(new URL("./session-retry.tsx", import.meta.url), "utf8")
const en = readFileSync(new URL("../i18n/en.ts", import.meta.url), "utf8")
const zh = readFileSync(new URL("../i18n/zh.ts", import.meta.url), "utf8")
const zht = readFileSync(new URL("../i18n/zht.ts", import.meta.url), "utf8")

test("the pre-first-progress wait reads as connecting, not thinking (#1358)", () => {
  // Provider output parts (text / reasoning / tool) mirror the backend's
  // `isProviderProgressEvent` set: their presence is the UI proxy for "the
  // provider has started responding". A `step-start` part must NOT flip the
  // phase — it can land before the first provider chunk.
  expect(turn).toContain('part.type === "text" || part.type === "reasoning" || part.type === "tool"')
  expect(turn).not.toContain('part.type === "step-start"')
  // The thinking slot carries the phase so the split is observable without
  // depending on copy/locale.
  expect(turn).toContain('data-phase={providerStarted() ? "thinking" : "connecting"}')
  // Both labels are wired; connecting is the pre-progress copy, thinking the
  // post-progress copy.
  expect(turn).toContain('i18n.t("ui.sessionTurn.status.connecting")')
  expect(turn).toContain('i18n.t("ui.sessionTurn.status.thinking")')
})

test("safe recovery shows the retry attempt, not just a generic recovering label", () => {
  // Recovery-in-progress should make clear PawWork is retrying the model
  // response (attempt N), not re-running a tool. Falls back to the plain
  // recovering label when no attempt count is available.
  expect(retry).toContain('i18n.t("ui.sessionTurn.retry.recoveryAttempt", { attempt: current().attempt })')
  expect(retry).toContain('i18n.t("ui.sessionTurn.retry.recovery")')
})

test("connecting and recovery-attempt copy exists in the runtime locales", () => {
  expect(en).toContain('"ui.sessionTurn.status.connecting": "Connecting"')
  expect(en).toContain('"ui.sessionTurn.retry.recoveryAttempt": "Recovering... attempt #{{attempt}}"')

  expect(zh).toContain('"ui.sessionTurn.status.connecting": "连接中"')
  expect(zh).toContain('"ui.sessionTurn.retry.recoveryAttempt": "正在恢复…第 {{attempt}} 次"')

  expect(zht).toContain('"ui.sessionTurn.status.connecting": "連線中"')
  expect(zht).toContain('"ui.sessionTurn.retry.recoveryAttempt": "正在恢復…第 {{attempt}} 次"')
})
