import { describe, expect, test } from "bun:test"
import { createFeedbackHandler } from "./feedback"

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
    opened: "",
    openExternalCount: 0,
    shown: "",
    showItemCount: 0,
    openedPath: "",
    cleanedUp: "",
    savedJson: "",
    errors: [] as unknown[],
    handledErrors: [] as string[],
  }
  return {
    calls,
    handler: createFeedbackHandler({
      feedbackUrl: "https://example.com/form",
      reportRoot: "/tmp/pawwork/problem-reports",
      context: () => "active",
      openExternal: async (url) => {
        calls.openExternalCount += 1
        calls.opened = url
      },
      showItemInFolder: async (path) => {
        calls.showItemCount += 1
        calls.shown = path
      },
      openPath: async (path) => {
        calls.openedPath = path
      },
      saveReport: async ({ json, reportId }) => {
        calls.savedJson = json
        return {
          path: `/tmp/pawwork/problem-reports/pawwork-problem-report-${reportId}.json`,
          fileName: `pawwork-problem-report-${reportId}.json`,
          locationHint: `PawWork app data/.../problem-reports/pawwork-problem-report-${reportId}.json`,
        }
      },
      cleanupReports: async (path) => {
        calls.cleanedUp = path
      },
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

describe("prepareReport", () => {
  test("saves the package and returns review metadata with no copy/reveal/form side effects", async () => {
    const subject = setup()
    const result = await subject.handler.prepareReport()

    expect(subject.calls.savedJson).toContain('"meta"')
    expect(subject.calls.savedJson).not.toContain("# PawWork Problem Report")
    expect(subject.calls.cleanedUp).toContain("/tmp/pawwork/problem-reports/")
    // Preparation is inert: reveal and form are the user's explicit follow-up choices.
    expect(subject.calls.openExternalCount).toBe(0)
    expect(subject.calls.showItemCount).toBe(0)
    expect(result).toEqual({
      status: "ready",
      reportId: expect.any(String),
      fileName: expect.stringContaining("pawwork-problem-report-"),
      locationHint: expect.stringContaining("problem-reports"),
      hasForm: true,
      contents: {
        logLines: 2,
        sessionMessages: null,
        rendererEvents: 0,
        rendererError: false,
      },
    })
  })

  test("reports contents counts from the gathered diagnostics", async () => {
    const subject = setup({
      sessionExport: async () => ({ status: "ok", info: {}, messages: [{}, {}, {}] }),
      rendererDiagnostics: async () => ({
        status: "ok",
        source: "renderer-diagnostics",
        generated_at: "2026-04-23T01:02:03.004Z",
        events: [{ id: "1" }, { id: "2" }],
        summary: {
          event_count: 2,
          incident_count: 0,
          statuses: ["ok"],
          omitted_event_count: 0,
          omitted_bytes: 0,
        },
      }),
    })

    const result = await subject.handler.prepareReport({
      rendererError: {
        summary: "PawWork had trouble reading local state.",
        details: "ChildStoreError: Failed to create persisted cache",
      },
    })

    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("expected ready")
    expect(result.contents).toEqual({
      logLines: 2,
      sessionMessages: 3,
      rendererEvents: 2,
      rendererError: true,
    })
    expect(subject.calls.savedJson).toContain("ChildStoreError: Failed to create persisted cache")
  })

  test("hasForm is false when no feedback URL is configured", async () => {
    const subject = setup({ feedbackUrl: "" })
    const result = await subject.handler.prepareReport()
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("expected ready")
    expect(result.hasForm).toBe(false)
    expect(subject.calls.savedJson).toContain('"meta"')
    expect(subject.calls.savedJson).not.toContain("# PawWork Problem Report")
  })

  test("session export failure downgrades the package but still prepares it", async () => {
    const subject = setup({
      sessionExport: async () => {
        throw new Error("session unavailable")
      },
    })
    const result = await subject.handler.prepareReport()
    expect(result.status).toBe("ready")
    expect(subject.calls.savedJson).toContain('"status": "failed"')
    expect(subject.calls.savedJson).toContain("session unavailable")
  })

  test("renderer diagnostics failure still prepares the package", async () => {
    const subject = setup({
      rendererDiagnostics: async () => {
        throw new Error("diagnostics unavailable")
      },
    })
    const result = await subject.handler.prepareReport()
    expect(result.status).toBe("ready")
    expect(subject.calls.handledErrors).toContain("renderer diagnostics slice failed")
    expect(subject.calls.savedJson).toContain('"status": "write_failed"')
  })

  test("slow renderer diagnostics times out and still prepares the package", async () => {
    const subject = setup({
      sessionExportTimeoutMs: 1,
      rendererDiagnostics: async () => new Promise(() => {}),
    })
    const result = await subject.handler.prepareReport()
    expect(result.status).toBe("ready")
    expect(subject.calls.handledErrors).toContain("renderer diagnostics slice failed")
    expect(subject.calls.savedJson).toContain('"status": "write_failed"')
  })

  test("slow session export times out, aborts, and still prepares the package", async () => {
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
    const result = await subject.handler.prepareReport()
    expect(result.status).toBe("ready")
    expect(aborted).toBe(true)
    expect(subject.calls.savedJson).toContain('"status": "failed"')
    expect(subject.calls.savedJson).toContain("session export timed out")
  })

  test("file write failure returns a copyable summary fallback without leaking paths", async () => {
    const subject = setup({
      saveReport: async () => {
        throw new Error("EACCES: /Users/name/problem-reports")
      },
    })
    const result = await subject.handler.prepareReport()
    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("expected failed")
    expect(result.reason).toBe("permission_denied")
    expect(result.summary).toContain("PawWork Problem Report Summary")
    expect(result.summary).toContain("Full report: not generated")
    expect(result.summary).not.toContain("/Users/name")
    expect(subject.calls.cleanedUp).toBe("")
  })

  test("full report construction failure returns a minimum summary fallback", async () => {
    const subject = setup({
      diagnostics: () => {
        throw new Error("diagnostics exploded")
      },
    })
    const result = await subject.handler.prepareReport()
    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("expected failed")
    expect(result.summary).toContain("PawWork Problem Report Summary")
    expect(result.summary).toContain("Full report: not generated")
  })

  test("cleanup failure does not block a ready package", async () => {
    const subject = setup({
      cleanupReports: async () => {
        throw new Error("cleanup failed")
      },
    })
    const result = await subject.handler.prepareReport()
    expect(result.status).toBe("ready")
    expect(subject.calls.handledErrors).toContain("problem report cleanup failed")
    expect(subject.calls.errors).toHaveLength(0)
  })

  test("busy guard shares one in-flight run and releases it afterwards", async () => {
    let runs = 0
    const subject = setup({
      diagnostics: () => {
        runs += 1
        return diagnostics
      },
    })
    const [a, b] = await Promise.all([subject.handler.prepareReport(), subject.handler.prepareReport()])
    expect(runs).toBe(1)
    expect(a).toEqual(b)
    await subject.handler.prepareReport()
    expect(runs).toBe(2)
  })

  test("does not share an in-flight run across different contexts", async () => {
    let runs = 0
    const subject = setup({
      diagnostics: () => {
        runs += 1
        return diagnostics
      },
    })
    // A manual prepare and an error-triggered prepare fired concurrently must each run: sharing
    // the in-flight promise would hand one context the other's package (wrong reportId to reveal/submit).
    const [a, b] = await Promise.all([
      subject.handler.prepareReport(),
      subject.handler.prepareReport({ rendererError: { summary: "boom", details: "x" } }),
    ])
    expect(runs).toBe(2)
    if (a.status !== "ready" || b.status !== "ready") throw new Error("expected ready")
    expect(a.contents.rendererError).toBe(false)
    expect(b.contents.rendererError).toBe(true)
  })

  test("passes the IPC sender window override to the context snapshot", async () => {
    let receivedOverride: unknown
    const subject = setup({
      context: (override) => {
        receivedOverride = override
        return "active"
      },
    })
    await subject.handler.prepareReport(undefined, { windowID: 7 })
    expect(receivedOverride).toEqual({ windowID: 7 })
  })

  test("never rejects: an unexpected throw resolves to a failed result and notifies onError", async () => {
    const subject = setup({
      context: () => {
        throw new Error("context exploded")
      },
    })
    await expect(subject.handler.prepareReport()).resolves.toEqual({
      status: "failed",
      reason: "report_failed",
      summary: "",
    })
    expect(subject.calls.errors).toHaveLength(1)
  })

  test("an onError handler failure does not reject the fallback", async () => {
    const subject = setup({
      context: () => {
        throw new Error("context exploded")
      },
      onError: () => {
        throw new Error("logger failed")
      },
    })
    await expect(subject.handler.prepareReport()).resolves.toMatchObject({ status: "failed" })
    expect(subject.calls.handledErrors).toContain("report problem error handler failed")
  })
})

describe("revealReport", () => {
  test("reveals the prepared package in the folder", async () => {
    const subject = setup()
    const result = await subject.handler.prepareReport()
    if (result.status !== "ready") throw new Error("expected ready")
    await expect(subject.handler.revealReport(result.reportId)).resolves.toEqual({ status: "revealed" })
    expect(subject.calls.shown).toContain("/tmp/pawwork/problem-reports/")
  })

  test("reports stale for a reveal of a report that is not the pending one", async () => {
    const subject = setup()
    await subject.handler.prepareReport()
    // A stale reveal is invisible to the renderer's IPC catch, so it must come back as an explicit
    // result the review surface can show — never a silent no-op.
    await expect(subject.handler.revealReport("not-the-pending-id")).resolves.toEqual({ status: "stale" })
    expect(subject.calls.showItemCount).toBe(0)
  })

  test("falls back to opening the directory when reveal fails", async () => {
    const subject = setup({
      showItemInFolder: async () => {
        throw new Error("reveal failed")
      },
    })
    const result = await subject.handler.prepareReport()
    if (result.status !== "ready") throw new Error("expected ready")
    await expect(subject.handler.revealReport(result.reportId)).resolves.toEqual({ status: "opened-directory" })
    expect(subject.calls.openedPath).toBe("/tmp/pawwork/problem-reports")
    expect(subject.calls.handledErrors).toContain("problem report reveal failed")
  })

  test("returns failed when reveal and the directory fallback both fail", async () => {
    const subject = setup({
      showItemInFolder: async () => {
        throw new Error("reveal failed")
      },
      openPath: async (path) => {
        subject.calls.openedPath = path
        return "No application is associated with the specified file"
      },
    })
    const result = await subject.handler.prepareReport()
    if (result.status !== "ready") throw new Error("expected ready")
    await expect(subject.handler.revealReport(result.reportId)).resolves.toEqual({ status: "failed" })
    expect(subject.calls.openedPath).toBe("/tmp/pawwork/problem-reports")
    expect(subject.calls.handledErrors).toContain("problem report directory open failed")
  })
})

describe("submitReport", () => {
  test("opens the feedback form", async () => {
    const subject = setup()
    const result = await subject.handler.prepareReport()
    if (result.status !== "ready") throw new Error("expected ready")
    await expect(subject.handler.submitReport(result.reportId)).resolves.toEqual({ status: "opened" })
    expect(subject.calls.opened).toBe("https://example.com/form")
  })

  test("ignores a submit for a report that is not the pending one", async () => {
    const subject = setup()
    await subject.handler.prepareReport()
    await expect(subject.handler.submitReport("not-the-pending-id")).resolves.toEqual({ status: "stale" })
    expect(subject.calls.openExternalCount).toBe(0)
  })

  test("returns no-form when there is no feedback URL", async () => {
    const subject = setup({ feedbackUrl: "" })
    const result = await subject.handler.prepareReport()
    if (result.status !== "ready") throw new Error("expected ready")
    await expect(subject.handler.submitReport(result.reportId)).resolves.toEqual({ status: "no-form" })
    expect(subject.calls.openExternalCount).toBe(0)
  })

  test("a form open failure returns the url and copyable summary for manual submission", async () => {
    const subject = setup({
      openExternal: async () => {
        throw new Error("browser unavailable")
      },
    })
    const result = await subject.handler.prepareReport()
    if (result.status !== "ready") throw new Error("expected ready")
    const submitted = await subject.handler.submitReport(result.reportId)
    expect(submitted.status).toBe("form-fallback")
    if (submitted.status !== "form-fallback") throw new Error("expected form-fallback")
    expect(submitted.feedbackUrl).toBe("https://example.com/form")
    expect(submitted.summary).toContain("PawWork Problem Report Summary")
    expect(subject.calls.handledErrors).toContain("feedback form open failed")
    expect(subject.calls.errors).toHaveLength(0)
  })
})
