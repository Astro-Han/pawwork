/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { describe, expect, spyOn, test } from "bun:test"
import * as sdkContext from "../../../src/cli/cmd/tui/context/sdk"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

describe("SDKProvider reconnect handling", () => {
  test("restarts reconnect delay from the base after a successful connection", async () => {
    const starts: number[] = []
    const fetchFn = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname !== "/global/event") {
        throw new Error(`unexpected request: ${url.pathname}`)
      }

      starts.push(Date.now())
      if (starts.length === 1) throw new Error("boom")
      return new Response("", {
        headers: {
          "content-type": "text/event-stream",
        },
      })
    }, { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) }) satisfies typeof fetch

    const app = await testRender(() => (
      <sdkContext.SDKProvider url="http://test" fetch={fetchFn}>
        <box />
      </sdkContext.SDKProvider>
    ))

    try {
      await wait(() => starts.length >= 3, 2600)
      expect(starts[2] - starts[1]).toBeLessThan(1500)
    } finally {
      app.renderer.destroy()
    }
  })

  test("removes abort listeners after reconnect sleep resolves normally", async () => {
    const sleepWithAbort = (sdkContext as Record<string, unknown>).sleepWithAbort as
      | ((ms: number, signals: AbortSignal[]) => Promise<void>)
      | undefined

    const outer = new AbortController()
    const inner = new AbortController()
    const outerRemove = spyOn(outer.signal, "removeEventListener")
    const innerRemove = spyOn(inner.signal, "removeEventListener")

    await sleepWithAbort?.(5, [outer.signal, inner.signal])

    expect(typeof sleepWithAbort).toBe("function")
    expect(outerRemove).toHaveBeenCalled()
    expect(innerRemove).toHaveBeenCalled()
  })
})
