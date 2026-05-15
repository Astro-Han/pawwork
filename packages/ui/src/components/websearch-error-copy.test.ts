import { expect, test } from "bun:test"
import { dict as en } from "../i18n/en"
import { dict as zh } from "../i18n/zh"
import { webSearchErrorDisplay } from "./websearch-error-copy"

function i18n(dict: Record<string, string>) {
  return {
    t: (key: string) => dict[key] ?? en[key] ?? key,
  }
}

test("websearch anonymous quota failure gets actionable English copy", () => {
  const display = webSearchErrorDisplay(
    { webSearch: { failure: { kind: "quota_exceeded", source: "anonymous", status: 429 } } },
    i18n(en),
  )

  expect(display).toEqual({
    subtitle: "Search quota reached",
    error:
      "The bundled Web Search quota has been used up. Add an Exa API key in Settings, or configure EXA_API_KEY, then try again.",
  })
})

test("websearch saved key failure gets actionable Chinese copy", () => {
  const display = webSearchErrorDisplay(
    { webSearch: { failure: { kind: "invalid_key", source: "saved", status: 401 } } },
    i18n(zh),
  )

  expect(display).toEqual({
    subtitle: "Exa API Key 需要处理",
    error: "保存的 Exa API Key 无效。请在设置里更新或删除后再试。",
  })
})

test("websearch failure copy covers env quota, network, and unknown fallbacks", () => {
  expect(
    webSearchErrorDisplay({ webSearch: { failure: { kind: "quota_exceeded", source: "env" } } }, i18n(zh)),
  ).toEqual({
    subtitle: "搜索额度已用完",
    error: "EXA_API_KEY 的搜索额度已用完。请更新环境变量，或换一个 key 后再试。",
  })
  expect(webSearchErrorDisplay({ webSearch: { failure: { kind: "network" } } }, i18n(en))).toEqual({
    subtitle: "Cannot reach Web Search",
    error: "PawWork could not connect to Exa for Web Search. Check your network connection, then try again.",
  })
  expect(webSearchErrorDisplay({ webSearch: { failure: { kind: "new-provider-error" } } }, i18n(zh))).toEqual({
    subtitle: "网络搜索失败",
    error: "PawWork 联系 Exa 时失败了。请稍后再试；如果一直失败，可以在设置里更新 Exa API Key。",
  })
})

test("websearch failure copy does not guess the credential source when metadata omits it", () => {
  expect(webSearchErrorDisplay({ webSearch: { failure: { kind: "quota_exceeded" } } }, i18n(en))).toEqual({
    subtitle: "Search quota reached",
    error:
      "Web Search quota has been reached. Add or update an Exa API key in Settings, configure EXA_API_KEY, or try again later.",
  })
  expect(webSearchErrorDisplay({ webSearch: { failure: { kind: "invalid_key" } } }, i18n(zh))).toEqual({
    subtitle: "Exa API Key 需要处理",
    error: "Exa 拒绝了网络搜索请求。请检查设置里的 Exa API Key，或稍后再试。",
  })
})

test("websearch failure copy leaves unrelated tool errors on the raw path", () => {
  expect(webSearchErrorDisplay({}, i18n(en))).toBeUndefined()
  expect(webSearchErrorDisplay({ webSearch: {} }, i18n(en))).toBeUndefined()
})
