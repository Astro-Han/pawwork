import { describe, expect, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"
import { contextUsageRingPercent, contextUsageTone } from "./session-context-usage-state"

const showAccessorBehaviorCheck = String.raw`
import { batch, createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Show } from "solid-js"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const unsafeRoot = document.createElement("div")
let staleAccessor
let clearContext
const disposeUnsafe = render(
  () => {
    const [context, setContext] = createSignal({ label: "Context usage" })
    clearContext = () => batch(() => setContext(undefined))
    return createComponent(Show, {
      get when() {
        return context()
      },
      children: (current) => {
        staleAccessor = current
        return document.createTextNode(current().label)
      },
    })
  },
  unsafeRoot,
)

assert(staleAccessor().label === "Context usage", "callback-form Show accessor should expose the current context first")
clearContext()
let staleError
try {
  staleAccessor()
} catch (error) {
  staleError = error
}
assert(String(staleError) === "Stale read from <Show>.", "callback-form Show accessor should throw after the when value disappears")
disposeUnsafe()

const safeRoot = document.createElement("div")
let clearContextUsedLabel
const disposeSafe = render(
  () => {
    const [contextUsedLabel, setContextUsedLabel] = createSignal("Context usage")
    clearContextUsedLabel = () => batch(() => setContextUsedLabel(undefined))
    return createComponent(Show, {
      get when() {
        return contextUsedLabel()
      },
      get children() {
        return document.createTextNode(contextUsedLabel() ?? "")
      },
    })
  },
  safeRoot,
)

clearContextUsedLabel()
disposeSafe()
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

describe("Solid Show context usage behavior", () => {
  test("avoids stale callback accessors when context metrics disappear", () => {
    runBrowserCheck(showAccessorBehaviorCheck)
  })
})
