import { describe, expect, test } from "bun:test"
import { updateErrorPageState } from "./error-update"

const t = (key: string, vars?: Record<string, string | number | boolean>) => {
  if (key === "error.page.action.upToDate") return "PawWork is up to date."
  if (key === "error.page.action.busy") return "PawWork is already checking for updates."
  if (key === "error.page.action.checkFailed") return "Failed to check for updates."
  if (key === "error.page.action.disabled") return "Updates are not available in this build."
  if (key === "error.page.action.updateTo") return `Update to ${vars?.version ?? ""}`
  return key
}

describe("error page update state", () => {
  test("shows available update version", () => {
    expect(updateErrorPageState({ updateAvailable: true, version: "0.2.5", status: "ready" }, t)).toEqual({
      version: "0.2.5",
      actionError: undefined,
      actionMessage: undefined,
    })
  })

  test("shows no-update feedback", () => {
    expect(updateErrorPageState({ updateAvailable: false, status: "none" }, t)).toEqual({
      version: undefined,
      actionError: undefined,
      actionMessage: "PawWork is up to date.",
    })
  })

  test("shows busy feedback", () => {
    expect(updateErrorPageState({ updateAvailable: false, status: "busy" }, t)).toEqual({
      version: undefined,
      actionError: undefined,
      actionMessage: "PawWork is already checking for updates.",
    })
  })

  test("shows failed feedback", () => {
    expect(
      updateErrorPageState({ updateAvailable: false, status: "failed", reason: "check", message: "network down" }, t),
    ).toEqual({
      version: undefined,
      actionError: "network down",
      actionMessage: undefined,
    })
  })

  test("falls back to generic failed feedback when message is empty", () => {
    expect(
      updateErrorPageState({ updateAvailable: false, status: "failed", reason: "check", message: "" }, t),
    ).toEqual({
      version: undefined,
      actionError: "Failed to check for updates.",
      actionMessage: undefined,
    })
  })

  test("shows disabled feedback", () => {
    expect(updateErrorPageState({ updateAvailable: false, status: "disabled" }, t)).toEqual({
      version: undefined,
      actionError: undefined,
      actionMessage: "Updates are not available in this build.",
    })
  })
})
