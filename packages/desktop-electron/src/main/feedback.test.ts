import { describe, expect, test } from "bun:test"
import { createFeedbackHandler, feedbackDialogLabels } from "./feedback"

const diagnostics = {
  appVersion: "0.2.4",
  channel: "prod",
  packaged: true,
  updaterEnabled: true,
  platform: "darwin" as NodeJS.Platform,
  osVersion: "Darwin 25.0.0",
  arch: "arm64",
  electronVersion: "40.8.0",
  locale: "en",
  route: "/session/ses_1",
  directory: "/tmp/project",
  sessionID: "ses_1",
  logPath: "/tmp/main.log",
}

function setup(overrides: Partial<Parameters<typeof createFeedbackHandler>[0]> = {}) {
  const calls = {
    copied: "",
    opened: "",
    errors: [] as unknown[],
  }
  return {
    calls,
    handler: createFeedbackHandler({
      feedbackUrl: "https://example.com/form",
      confirm: async () => true,
      copy: async (value) => {
        calls.copied = value
      },
      openExternal: async (url) => {
        calls.opened = url
      },
      diagnostics: () => diagnostics,
      logTail: () => "log tail",
      sessionExport: async () => ({ status: "none" }),
      onError: (error) => {
        calls.errors.push(error)
      },
      ...overrides,
    }),
  }
}

describe("feedback handler", () => {
  test("has localized confirmation labels for Simplified Chinese", () => {
    expect(feedbackDialogLabels("zh").title).toBe("复制问题报告？")
    expect(feedbackDialogLabels("zh").confirm).toBe("复制报告并打开表单")
  })

  test("has English confirmation labels", () => {
    expect(feedbackDialogLabels("en").title).toBe("Copy problem report?")
    expect(feedbackDialogLabels("en").confirm).toBe("Copy report and open form")
    expect(feedbackDialogLabels("en").failedTitle).toBe("Problem Report Failed")
  })

  test("falls back to English confirmation labels", () => {
    expect(feedbackDialogLabels("fr" as never).title).toBe("Copy problem report?")
    expect(feedbackDialogLabels("fr" as never).confirm).toBe("Copy report and open form")
  })

  test("cancel does not copy or open", async () => {
    const subject = setup({ confirm: async () => false })
    await subject.handler()
    expect(subject.calls.copied).toBe("")
    expect(subject.calls.opened).toBe("")
  })

  test("confirm copies report and opens form", async () => {
    const subject = setup()
    await subject.handler()
    expect(subject.calls.copied).toContain("PawWork Problem Report")
    expect(subject.calls.opened).toBe("https://example.com/form")
  })

  test("uses the context captured before confirmation", async () => {
    let current = "active"
    let exportedContext: unknown
    let diagnosticsContext: unknown
    const subject = setup({
      context: () => current,
      confirm: async () => {
        current = "background"
        return true
      },
      diagnostics: (context) => {
        diagnosticsContext = context
        return diagnostics
      },
      sessionExport: async (context) => {
        exportedContext = context
        return { status: "none" }
      },
    })

    await subject.handler()

    expect(exportedContext).toBe("active")
    expect(diagnosticsContext).toBe("active")
  })

  test("session export failure downgrades report", async () => {
    const subject = setup({
      sessionExport: async () => {
        throw new Error("session unavailable")
      },
    })
    await subject.handler()
    expect(subject.calls.copied).toContain('"status": "failed"')
    expect(subject.calls.opened).toBe("https://example.com/form")
  })

  test("missing feedback URL does not copy or open", async () => {
    const subject = setup({ feedbackUrl: "" })
    await subject.handler()
    expect(subject.calls.copied).toBe("")
    expect(subject.calls.opened).toBe("")
  })

  test("non-session failures are reported without rejecting", async () => {
    const subject = setup({
      copy: async () => {
        throw new Error("clipboard unavailable")
      },
    })

    await expect(subject.handler()).resolves.toBeUndefined()
    expect(subject.calls.errors).toHaveLength(1)
    expect(subject.calls.opened).toBe("")
  })
})
