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
    fallbackUrl: "",
    shown: "",
    openedPath: "",
    savedMarkdown: "",
    errors: [] as unknown[],
    handledErrors: [] as string[],
  }
  return {
    calls,
    handler: createFeedbackHandler({
      feedbackUrl: "https://example.com/form",
      reportRoot: "/tmp/pawwork/problem-reports",
      context: () => "active",
      confirm: async () => true,
      copy: async (value) => {
        calls.copied = value
      },
      openExternal: async (url) => {
        calls.opened = url
      },
      showFeedbackUrlFallback: async (url) => {
        calls.fallbackUrl = url
      },
      showItemInFolder: async (path) => {
        calls.shown = path
      },
      openPath: async (path) => {
        calls.openedPath = path
      },
      saveReport: async ({ markdown, reportId }) => {
        calls.savedMarkdown = markdown
        return {
          path: `/tmp/pawwork/problem-reports/pawwork-problem-report-${reportId}.md`,
          fileName: `pawwork-problem-report-${reportId}.md`,
          locationHint: `PawWork app data/.../problem-reports/pawwork-problem-report-${reportId}.md`,
        }
      },
      cleanupReports: async () => undefined,
      sessionExportTimeoutMs: 10,
      diagnostics: () => diagnostics,
      logTail: () => "log tail\n[error] launch failed",
      sessionExport: async () => ({ status: "none" }),
      rendererDiagnostics: async () => ({
        status: "ok",
        source: "renderer-diagnostics",
        generated_at: "2026-04-23T01:02:03.004Z",
        events: [],
        summary: {
          event_count: 0,
          incident_count: 0,
          statuses: ["ok"],
          omitted_event_count: 0,
          omitted_bytes: 0,
        },
      }),
      onHandledError: (message) => {
        calls.handledErrors.push(message)
      },
      onError: (error) => {
        calls.errors.push(error)
      },
      ...overrides,
    }),
  }
}

describe("feedback handler", () => {
  test("has localized confirmation labels for Simplified Chinese", () => {
    expect(feedbackDialogLabels("zh").title).toBe("准备诊断包？")
    expect(feedbackDialogLabels("zh").confirm).toBe("准备诊断包并打开表单")
    expect(feedbackDialogLabels("zh").message).toContain("会话内容")
    expect(feedbackDialogLabels("zh").message).toContain("界面诊断")
    expect(feedbackDialogLabels("zh").message).toContain("应用日志")
    expect(feedbackDialogLabels("zh").message).toContain("环境信息")
    expect(feedbackDialogLabels("zh").message).toContain("本地路径")
    expect(feedbackDialogLabels("zh").message).not.toContain("PawWork")
    expect(feedbackDialogLabels("zh").formOpenFailedMessage).not.toContain("PawWork")
  })

  test("has English confirmation labels", () => {
    expect(feedbackDialogLabels("en").title).toBe("Prepare diagnostics package?")
    expect(feedbackDialogLabels("en").confirm).toBe("Prepare package and open form")
    expect(feedbackDialogLabels("en").message).toContain("session content")
    expect(feedbackDialogLabels("en").message).toContain("renderer diagnostics")
    expect(feedbackDialogLabels("en").message).toContain("app logs")
    expect(feedbackDialogLabels("en").message).toContain("environment information")
    expect(feedbackDialogLabels("en").message).toContain("local paths")
    expect(feedbackDialogLabels("en").failedTitle).toBe("Diagnostics Package Failed")
  })

  test("has package-only confirmation labels when no feedback form is configured", () => {
    const english = feedbackDialogLabels("en", { withForm: false })
    expect(english.confirm).toBe("Prepare package")
    expect(english.message).toContain("This build does not have a feedback form configured")
    expect(english.message).not.toContain("open the feedback form")

    const chinese = feedbackDialogLabels("zh", { withForm: false })
    expect(chinese.confirm).toBe("准备诊断包")
    expect(chinese.message).toContain("当前构建没有配置反馈表单")
    expect(chinese.message).not.toContain("打开反馈表单")
  })

  test("falls back to English confirmation labels", () => {
    expect(feedbackDialogLabels("fr" as never).title).toBe("Prepare diagnostics package?")
    expect(feedbackDialogLabels("fr" as never).confirm).toBe("Prepare package and open form")
  })

  test("cancel does not copy or open", async () => {
    const subject = setup({ confirm: async () => false })
    await subject.handler()
    expect(subject.calls.copied).toBe("")
    expect(subject.calls.opened).toBe("")
  })

  test("confirm copies a short summary, saves the full report, reveals the file, and opens form", async () => {
    const subject = setup()
    const result = await subject.handler()
    expect(subject.calls.copied).toContain("PawWork Problem Report Summary")
    expect(subject.calls.copied).toContain("Full report: ready for manual upload")
    expect(subject.calls.copied).not.toContain("```json")
    expect(subject.calls.savedMarkdown).toContain("# PawWork Problem Report")
    expect(subject.calls.shown).toContain("/tmp/pawwork/problem-reports/")
    expect(subject.calls.opened).toBe("https://example.com/form")
    expect(result).toEqual({
      status: "ready",
      summaryCopied: true,
      feedbackOpened: true,
      fullReport: {
        status: "ready",
        fileName: expect.stringContaining("pawwork-problem-report-"),
        locationHint: expect.stringContaining("problem-reports"),
      },
    })
  })

  test("renderer callers can skip menu confirmation and include current error details", async () => {
    let confirms = 0
    const subject = setup({
      confirm: async () => {
        confirms += 1
        return true
      },
    })
    const result = await subject.handler({
      confirm: false,
      rendererError: {
        summary: "PawWork had trouble reading local state.",
        details: "ChildStoreError: Failed to create persisted cache\nCaused by:\nTypeError: storage init failed",
      },
    })

    expect(confirms).toBe(0)
    expect(subject.calls.copied).toContain("Renderer error: PawWork had trouble reading local state.")
    expect(subject.calls.savedMarkdown).toContain("ChildStoreError: Failed to create persisted cache")
    expect(result.status).toBe("ready")
  })

  test("busy guard starts before confirmation and releases on cancel", async () => {
    let confirms = 0
    let resolveConfirm: (value: boolean) => void = () => undefined
    const firstConfirm = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve
    })
    const subject = setup({
      confirm: async () => {
        confirms += 1
        return firstConfirm
      },
    })

    const first = subject.handler()
    const second = subject.handler()
    resolveConfirm(false)
    await Promise.all([first, second])

    expect(confirms).toBe(1)
    expect(subject.calls.copied).toBe("")
    await subject.handler()
    expect(confirms).toBe(2)
  })

  test("uses the context snapshotted before confirmation changes focus", async () => {
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

  test("passes IPC sender window override to context snapshot", async () => {
    let receivedOverride: unknown
    const subject = setup({
      context: (override) => {
        receivedOverride = override
        return "active"
      },
    })

    await subject.handler(undefined, { windowID: 7 })

    expect(receivedOverride).toEqual({ windowID: 7 })
  })

  test("session export failure downgrades report", async () => {
    const subject = setup({
      sessionExport: async () => {
        throw new Error("session unavailable")
      },
    })
    await subject.handler()
    expect(subject.calls.savedMarkdown).toContain('"status": "failed"')
    expect(subject.calls.savedMarkdown).toContain("session unavailable")
    expect(subject.calls.copied).toContain("PawWork Problem Report Summary")
    expect(subject.calls.opened).toBe("https://example.com/form")
  })

  test("renderer diagnostics failure still produces report artifacts", async () => {
    const subject = setup({
      rendererDiagnostics: async () => {
        throw new Error("diagnostics unavailable")
      },
    })

    await subject.handler()

    expect(subject.calls.handledErrors).toContain("renderer diagnostics slice failed")
    expect(subject.calls.savedMarkdown).toContain('"status": "write_failed"')
    expect(subject.calls.copied).toContain("Renderer diagnostics: write_failed")
    expect(subject.calls.opened).toBe("https://example.com/form")
  })

  test("slow renderer diagnostics times out and still produces report artifacts", async () => {
    const subject = setup({
      sessionExportTimeoutMs: 1,
      rendererDiagnostics: async () => new Promise(() => {}),
    })

    await subject.handler()

    expect(subject.calls.handledErrors).toContain("renderer diagnostics slice failed")
    expect(subject.calls.savedMarkdown).toContain('"status": "write_failed"')
    expect(subject.calls.copied).toContain("Renderer diagnostics: write_failed")
    expect(subject.calls.opened).toBe("https://example.com/form")
  })

  test("slow session export times out and still produces report artifacts", async () => {
    let aborted = false
    const subject = setup({
      sessionExportTimeoutMs: 1,
      sessionExport: async (_context, signal) =>
        new Promise(() => {
          signal?.addEventListener("abort", () => {
            aborted = true
          })
        }),
    })

    await subject.handler()

    expect(aborted).toBe(true)
    expect(subject.calls.copied).toContain("PawWork Problem Report Summary")
    expect(subject.calls.savedMarkdown).toContain('"status": "failed"')
    expect(subject.calls.savedMarkdown).toContain("session export timed out")
    expect(subject.calls.opened).toBe("https://example.com/form")
  })

  test("file write failure still copies summary and opens form without attachment instructions", async () => {
    const subject = setup({
      saveReport: async () => {
        throw new Error("EACCES: /Users/name/problem-reports")
      },
    })

    const result = await subject.handler()

    expect(subject.calls.copied).toContain("Full report: not generated")
    expect(subject.calls.copied).toContain("Submit this summary without an attachment if needed.")
    expect(subject.calls.copied).not.toContain("/Users/name")
    expect(subject.calls.shown).toBe("")
    expect(subject.calls.opened).toBe("https://example.com/form")
    expect(result.status).toBe("summary-only")
  })

  test("full report construction failure still copies a minimum summary and opens form", async () => {
    const subject = setup({
      diagnostics: () => {
        throw new Error("diagnostics exploded")
      },
    })

    await subject.handler()

    expect(subject.calls.copied).toContain("PawWork Problem Report Summary")
    expect(subject.calls.copied).toContain("Full report: not generated")
    expect(subject.calls.opened).toBe("https://example.com/form")
  })

  test("form open failure is reported after summary and report file are available", async () => {
    const subject = setup({
      openExternal: async () => {
        throw new Error("browser unavailable")
      },
    })

    const result = await subject.handler()

    expect(subject.calls.copied).toContain("PawWork Problem Report Summary")
    expect(subject.calls.savedMarkdown).toContain("# PawWork Problem Report")
    expect(subject.calls.fallbackUrl).toBe("https://example.com/form")
    expect(subject.calls.handledErrors).toContain("feedback form open failed")
    expect(subject.calls.errors).toHaveLength(0)
    expect(result.status).toBe("form-fallback")
    expect(result.feedbackUrl).toBe("https://example.com/form")
  })

  test("file reveal failure still opens the form and keeps summary recovery information", async () => {
    const subject = setup({
      showItemInFolder: async () => {
        throw new Error("reveal failed")
      },
    })

    await subject.handler()

    expect(subject.calls.copied).toContain("problem-reports")
    expect(subject.calls.openedPath).toBe("/tmp/pawwork/problem-reports")
    expect(subject.calls.opened).toBe("https://example.com/form")
    expect(subject.calls.handledErrors).toContain("problem report reveal failed")
  })

  test("directory open fallback reports Electron openPath error strings", async () => {
    const subject = setup({
      showItemInFolder: async () => {
        throw new Error("reveal failed")
      },
      openPath: async (path) => {
        subject.calls.openedPath = path
        return "No application is associated with the specified file"
      },
    })

    await subject.handler()

    expect(subject.calls.openedPath).toBe("/tmp/pawwork/problem-reports")
    expect(subject.calls.opened).toBe("https://example.com/form")
    expect(subject.calls.handledErrors).toContain("problem report directory open failed")
  })

  test("cleanup failure does not block opening the form", async () => {
    const subject = setup({
      cleanupReports: async () => {
        throw new Error("cleanup failed")
      },
    })

    await subject.handler()

    expect(subject.calls.copied).toContain("PawWork Problem Report Summary")
    expect(subject.calls.shown).toContain("/tmp/pawwork/problem-reports/")
    expect(subject.calls.opened).toBe("https://example.com/form")
    expect(subject.calls.errors).toHaveLength(0)
    expect(subject.calls.handledErrors).toContain("problem report cleanup failed")
  })

  test("missing feedback URL still prepares a local diagnostics package", async () => {
    const subject = setup({ feedbackUrl: "" })
    const result = await subject.handler()
    expect(subject.calls.copied).toContain("PawWork Problem Report Summary")
    expect(subject.calls.savedMarkdown).toContain("# PawWork Problem Report")
    expect(subject.calls.shown).toContain("/tmp/pawwork/problem-reports/")
    expect(subject.calls.opened).toBe("")
    expect(result).toEqual({
      status: "package-only",
      summaryCopied: true,
      feedbackOpened: false,
      fullReport: {
        status: "ready",
        fileName: expect.stringContaining("pawwork-problem-report-"),
        locationHint: expect.stringContaining("problem-reports"),
      },
    })
  })

  test("non-session failures are reported without rejecting", async () => {
    const subject = setup({
      copy: async () => {
        throw new Error("clipboard unavailable")
      },
    })

    await expect(subject.handler()).resolves.toEqual({
      status: "failed",
      summaryCopied: false,
      feedbackOpened: false,
      fullReport: { status: "failed" },
    })
    expect(subject.calls.errors).toHaveLength(1)
    expect(subject.calls.opened).toBe("")
  })

  test("onError failures do not reject the report fallback", async () => {
    const subject = setup({
      copy: async () => {
        throw new Error("clipboard unavailable")
      },
      onError: () => {
        throw new Error("logger failed")
      },
    })

    await expect(subject.handler()).resolves.toEqual({
      status: "failed",
      summaryCopied: false,
      feedbackOpened: false,
      fullReport: { status: "failed" },
    })
    expect(subject.calls.handledErrors).toContain("report problem error handler failed")
    expect(subject.calls.opened).toBe("")
  })
})
