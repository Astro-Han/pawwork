import type { Message, NoticePart } from "@opencode-ai/sdk/v2"
import { Dynamic, render } from "solid-js/web"
import { I18nProvider, type UiI18n, type UiI18nKey, type UiI18nParams } from "../../src/context/i18n"
import { dict as en } from "../../src/i18n/en"
import { dict as zh } from "../../src/i18n/zh"
import { PART_MAPPING } from "../../src/components/message-part/registry"
// Importing the part module registers the "notice" component into PART_MAPPING.
import "../../src/components/message-part/parts/notice"

export const dicts = { en, zh }

function i18nFor(dict: Record<string, string>): UiI18n {
  return {
    locale: () => "test",
    t: (key: UiI18nKey, params?: UiI18nParams) => {
      const template = dict[key] ?? en[key] ?? String(key)
      return template.replace(/{{\s*([^}]+?)\s*}}/g, (_, raw) => String(params?.[String(raw)] ?? ""))
    },
  }
}

// A notice carrying ONLY the backend `sideEffect` flag — no tool part, no
// DataProvider, no turn context. If the UI still picks the right copy, it must
// be reading the field alone, not scanning/classifying tools (#1358).
function notice(sideEffect: boolean | undefined): NoticePart {
  return {
    id: "prt_notice",
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "notice",
    kind: "safe_retry_failed",
    ...(sideEffect === undefined ? {} : { sideEffect }),
    time: { created: 1 },
  }
}

// The component reads only props.part; message is required by the prop type but
// never touched, so a stub stands in.
const MESSAGE = { id: "msg_test" } as unknown as Message

export function mountNotice(sideEffect: boolean | undefined, dict: Record<string, string> = en) {
  const Comp = PART_MAPPING["notice"]
  if (!Comp) throw new Error("notice part component is not registered")
  const host = document.createElement("div")
  document.body.append(host)

  const dispose = render(
    () => (
      <I18nProvider value={i18nFor(dict)}>
        <Dynamic component={Comp} part={notice(sideEffect)} message={MESSAGE} />
      </I18nProvider>
    ),
    host,
  )

  const root = () => host.querySelector("[data-component='notice-part']") as HTMLElement | null
  return {
    host,
    variant: () => root()?.getAttribute("data-variant") ?? null,
    title: () => host.querySelector("[data-slot='notice-title']")?.textContent ?? null,
    body: () => host.querySelector("[data-slot='notice-body']")?.textContent ?? null,
    // No tool card is ever mounted — proves the copy did not come from a tool scan.
    toolCard: () => host.querySelector("[data-component='tool']"),
    dispose: () => {
      dispose()
      host.remove()
    },
  }
}
