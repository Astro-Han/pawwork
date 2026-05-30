import { describe, expect, test } from "bun:test"
import { ciSmokeCdpSwitches } from "./ci-smoke-cdp"

describe("CI smoke CDP switches", () => {
  test("enables renderer CDP only for CI smoke runs with a valid loopback port", () => {
    expect(ciSmokeCdpSwitches({ PAWWORK_CI_SMOKE: "true", PAWWORK_CI_SMOKE_CDP_PORT: "48291" })).toEqual([
      ["remote-debugging-port", "48291"],
      ["remote-debugging-address", "127.0.0.1"],
      ["remote-allow-origins", "*"],
    ])
  })

  test("keeps normal desktop launches CDP-free", () => {
    expect(ciSmokeCdpSwitches({ PAWWORK_CI_SMOKE_CDP_PORT: "48291" })).toEqual([])
    expect(ciSmokeCdpSwitches({ PAWWORK_CI_SMOKE: "true" })).toEqual([])
    expect(ciSmokeCdpSwitches({ PAWWORK_CI_SMOKE: "true", PAWWORK_CI_SMOKE_CDP_PORT: "0" })).toEqual([])
    expect(ciSmokeCdpSwitches({ PAWWORK_CI_SMOKE: "true", PAWWORK_CI_SMOKE_CDP_PORT: "not-a-port" })).toEqual([])
  })
})
