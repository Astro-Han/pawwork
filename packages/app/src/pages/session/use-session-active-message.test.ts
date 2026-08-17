import { describe, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

const browserCheck = String.raw`
import { createRoot, createSignal } from "solid-js"
import { createSessionActiveMessage } from "./src/pages/session/use-session-active-message.ts"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const previous = { id: "msg_fdffffffffffffffffffffffffff", role: "user" }
let active
let setLatest
const dispose = createRoot((dispose) => {
  const [latest, setLatestID] = createSignal(previous.id)
  setLatest = setLatestID
  active = createSessionActiveMessage({
    sessionKey: () => "ses_1",
    visibleUserMessages: () => [previous],
    lastUserMessageID: latest,
    scroller: () => undefined,
    resumeScroll: () => {},
    pauseAutoScroll: () => {},
  })
  active.setActiveMessage(previous)
  return dispose
})

await Promise.resolve()
setLatest("msg_0000000000000000000000000000")
await Promise.resolve()

assert(active.messageId() === undefined, "a wrapped latest ID should clear the active message anchor")
dispose()
`

describe("createSessionActiveMessage", () => {
  test("clears the active anchor when the latest message ID wraps", () => {
    runBrowserCheck(browserCheck)
  })
})
