import { describe, expect, test } from "vitest"
import { assertDshPluginRequest } from "./dsh-plugins"

describe("PawWork DSH plugin requests", () => {
  test("accepts requests only from the owned DSH main frame", () => {
    expect(() => assertDshPluginRequest({
      dshUrl: "http://127.0.0.1:43123/",
      isMainFrame: true,
      senderUrl: "http://127.0.0.1:43123/settings/plugins",
    })).not.toThrow()
    expect(() => assertDshPluginRequest({
      dshUrl: "http://127.0.0.1:43123/",
      isMainFrame: true,
      senderUrl: "https://example.com/",
    })).toThrow("owned product frame")
    expect(() => assertDshPluginRequest({
      dshUrl: "http://127.0.0.1:43123/",
      isMainFrame: false,
      senderUrl: "http://127.0.0.1:43123/embedded",
    })).toThrow("owned product frame")
  })
})
