import { describe, expect, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"
import { contextUsageRingPercent, contextUsageTone } from "./session-context-usage-state"

const sessionContextUsageBehaviorCheck = String.raw`
import { mock } from "bun:test"
import { batch, createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

globalThis.React = {
  createElement(type, props, ...children) {
    if (typeof type === "function") return type({ ...(props ?? {}), children })
    return children
  },
}

const [messageList, setMessageList] = createSignal([])

mock.module("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props) => [props.value, props.children],
}))
mock.module("@opencode-ai/ui/progress-circle", () => ({
  ProgressCircle: () => document.createTextNode("progress"),
}))
mock.module("@opencode-ai/ui/button", () => ({
  Button: (props) => props.children,
}))
mock.module("@/context/sync", () => ({
  useSync: () => ({
    data: {
      get message() {
        return { session_a: messageList() }
      },
      config: {
        compaction: {
          auto: true,
          reserved: 1000,
        },
      },
    },
  }),
}))
mock.module("@/context/language", () => ({
  useLanguage: () => ({
    intl: () => "en-US",
    t: (key, values) => (values ? key + JSON.stringify(values) : key),
  }),
}))
mock.module("@/hooks/use-providers", () => ({
  useProviders: () => ({
    all: () => [
      {
        id: "provider",
        name: "Provider",
        models: {
          model: {
            name: "Model",
            limit: {
              context: 10000,
              input: 10000,
              output: 1000,
            },
          },
        },
      },
    ],
  }),
}))
mock.module("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    params: { id: "session_a" },
    view: () => ({
      sidePanel: {
        toggleTab: () => undefined,
      },
    }),
  }),
}))

const { SessionContextUsage } = await import("./src/components/session-context-usage.tsx")

setMessageList([
  {
    id: "msg_a",
    role: "assistant",
    providerID: "provider",
    modelID: "model",
    cost: 0.25,
    tokens: {
      total: 2100,
      input: 2000,
      output: 100,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    time: {
      created: 1,
    },
  },
])

const root = document.createElement("div")
const dispose = render(() => createComponent(SessionContextUsage, {}), root)

assert(root.textContent.includes("context.usage.title"), "context usage details should render before metrics disappear")
batch(() => setMessageList([]))
assert(root.textContent.includes("context.usage.cost"), "cost row should remain visible without context metrics")

dispose()
`

describe("session context usage indicator helpers", () => {
  test("uses normal tone for unknown usage and usage below warning", () => {
    expect(contextUsageTone(null)).toBe("normal")
    expect(contextUsageTone(69.9)).toBe("normal")
  })

  test("uses warning and danger thresholds", () => {
    expect(contextUsageTone(70)).toBe("warning")
    expect(contextUsageTone(89.9)).toBe("warning")
    expect(contextUsageTone(90)).toBe("danger")
  })

  test("clamps only ring drawing percentage", () => {
    expect(contextUsageRingPercent(null)).toBe(0)
    expect(contextUsageRingPercent(-1)).toBe(0)
    expect(contextUsageRingPercent(42.5)).toBe(42.5)
    expect(contextUsageRingPercent(120)).toBe(100)
  })
})

describe("SessionContextUsage render behavior", () => {
  test("does not read stale Show accessors when context metrics disappear", () => {
    runBrowserCheck(sessionContextUsageBehaviorCheck)
  })
})
