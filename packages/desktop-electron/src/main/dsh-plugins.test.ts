import { describe, expect, test, vi } from "vitest"
import { assertDshPluginRequest, requestDshCommunityMarket } from "./dsh-plugins"

describe("PawWork DSH community market bridge", () => {
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

  test("proxies one bounded action to the generation-owned DSH host", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      enabled: true,
      restartRequired: false,
      version: "1.21.0",
    }), { status: 200 }))

    await expect(requestDshCommunityMarket({
      action: "status",
      dshUrl: "http://127.0.0.1:43123/",
      fetchImpl,
      hostToken: "host-token",
    })).resolves.toEqual({ enabled: true, restartRequired: false, version: "1.21.0" })
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/pawwork/community-market/status",
      {
        headers: { "x-pawwork-host-token": "host-token" },
        method: "GET",
      },
    )
  })

  test("surfaces the host error instead of treating a partial install as success", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: "DSH did not activate a compatible community market" }),
      { status: 500 },
    ))

    await expect(requestDshCommunityMarket({
      action: "enable",
      dshUrl: "http://127.0.0.1:43123/",
      fetchImpl,
      hostToken: "host-token",
    })).rejects.toThrow("DSH did not activate a compatible community market")
  })
})
