import { describe, expect, test } from "bun:test"
import {
  buildErrorReportDetails,
  formatError,
  summarizeKnownError,
  type ErrorReportTranslator,
} from "./error-report"
import { ChildStoreError } from "@/context/global-sync/child-store-error"

const t: ErrorReportTranslator = (key) => {
  const dict: Record<string, string> = {
    "error.page.known.localState.title": "Local state problem",
    "error.page.known.localState.description":
      "PawWork had trouble reading local state for this workspace. Your original project files are usually not affected.",
    "error.chain.causedBy": "Caused by",
    "error.page.circular": "[Circular]",
  }
  return dict[key] ?? key
}

describe("error page reporting helpers", () => {
  test("summarizes child store failures as local state problems", () => {
    const error = new ChildStoreError("Failed to create persisted cache", {
      kind: "vcs",
      directory: "/Users/test/project",
      storage: "pawwork.workspace.project.abc123.dat",
      key: "workspace:vcs",
    })

    expect(summarizeKnownError(error, t)).toEqual({
      title: "Local state problem",
      description:
        "PawWork had trouble reading local state for this workspace. Your original project files are usually not affected.",
    })
  })

  test("includes child store context in full report details", () => {
    const error = new ChildStoreError("Failed to create persisted cache", {
      kind: "vcs",
      directory: "/Users/test/project",
      storage: "pawwork.workspace.project.abc123.dat",
      key: "workspace:vcs",
    })

    const details = buildErrorReportDetails(error, t)

    expect(details.summary).toBe(
      "PawWork had trouble reading local state for this workspace. Your original project files are usually not affected.",
    )
    expect(details.details).toContain("ChildStoreError: Failed to create persisted cache")
    expect(details.details).toContain("Context")
    expect(details.details).toContain('"kind": "vcs"')
    expect(details.details).toContain('"directory": "/Users/test/project"')
    expect(details.details).toContain('"storage": "pawwork.workspace.project.abc123.dat"')
    expect(details.details).toContain('"key": "workspace:vcs"')
  })

  test("keeps report summary short while preserving full error details", () => {
    const error = new Error("Failed to create persisted cache", { cause: new TypeError("storage init failed") })
    const details = buildErrorReportDetails(error, t)

    expect(details.summary).toBe("Failed to create persisted cache")
    expect(details.details).toContain("Error: Failed to create persisted cache")
    expect(details.details).toContain("TypeError: storage init failed")
  })

  test("formats error-like objects from another execution context", () => {
    const error = {
      name: "TypeError",
      message: "renderer realm failed",
      stack: "TypeError: renderer realm failed\n    at other-window.js:1:2",
      cause: {
        name: "Error",
        message: "storage init failed",
        stack: "Error: storage init failed\n    at storage.js:3:4",
      },
    }

    const details = buildErrorReportDetails(error, t)

    expect(details.summary).toBe("renderer realm failed")
    expect(formatError(error, t)).toContain("TypeError: renderer realm failed")
    expect(formatError(error, t)).toContain("Caused by")
    expect(formatError(error, t)).toContain("Error: storage init failed")
  })

  test("does not treat init errors with null data as known init errors", () => {
    const error = { name: "ProviderInitError", data: null }

    expect(() => formatError(error, t)).not.toThrow()
    expect(formatError(error, t)).toContain('"data": null')
  })

  test("formats cyclic error causes without overflowing", () => {
    const error = new Error("loop") as Error & { cause?: unknown }
    error.cause = error

    const formatted = formatError(error, t)

    expect(formatted).toContain("Error: loop")
    expect(formatted).toContain("Caused by")
    expect(formatted).toContain("[Circular]")
  })
})
