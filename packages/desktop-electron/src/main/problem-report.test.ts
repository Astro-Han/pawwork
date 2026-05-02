import { describe, expect, test } from "bun:test"
import { buildProblemReport, buildProblemReportSummary, parseProblemReportPayload } from "./problem-report"

const base = {
  diagnostics: {
    appVersion: "0.2.4",
    channel: "prod",
    packaged: true,
    updaterEnabled: true,
    platform: "darwin",
    osVersion: "Darwin 25.0.0",
    arch: "arm64",
    electronVersion: "40.8.0",
    locale: "zh",
    route: "/session/ses_1",
    directory: "/Users/test/project",
    sessionID: "ses_1",
    logPath: "/Users/test/Library/Logs/PawWork/main.log",
  },
  logTail: "line one\nline two",
  sessionExport: {
    status: "ok" as const,
    info: { id: "ses_1", title: "Bug", directory: "/Users/test/project" },
    messages: [
      {
        info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } },
        parts: [{ id: "part_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hello" }],
      },
    ],
  },
  rendererDiagnostics: {
    status: "ok" as const,
    source: "renderer-diagnostics" as const,
    generated_at: "2026-04-23T01:02:03.004Z",
    events: [
      {
        ts: "2026-04-23T01:02:03.004Z",
        "event.name": "session.action.submit",
        level: "info" as const,
        app_launch_id: "launch_1",
        window_id: "1",
        monotonic_ms: 10,
        route_session_id: "ses_1",
        visible_session_id: "ses_1",
        timeline_session_id: "ses_1",
        trace_id: "msg_1",
        data: { action: "submit", endpoint_kind: "prompt" },
      },
    ],
    summary: {
      event_count: 1,
      incident_count: 0,
      statuses: ["ok" as const],
      omitted_event_count: 0,
      omitted_bytes: 0,
    },
  },
}

describe("problem report", () => {
  test("uses caller-provided report id and generated time", () => {
    const report = buildProblemReport(base, {
      reportId: "pwr_20260423_abc123",
      generatedAt: "2026-04-23T01:02:03.004Z",
    })

    const payload = parseProblemReportPayload(report.markdown)
    expect(report.reportId).toBe("pwr_20260423_abc123")
    expect(report.generatedAt).toBe("2026-04-23T01:02:03.004Z")
    expect(payload.reportId).toBe("pwr_20260423_abc123")
    expect(payload.generatedAt).toBe("2026-04-23T01:02:03.004Z")
  })

  test("creates markdown with valid fenced JSON", () => {
    const report = buildProblemReport(base)
    expect(report.markdown).toContain("# PawWork Problem Report")
    expect(report.markdown).toContain("Upload this markdown file to the feedback form after reviewing it.")
    expect(report.markdown).not.toContain("Paste this report into the feedback form")
    const payload = parseProblemReportPayload(report.markdown)
    expect(payload.reportVersion).toBe(1)
    expect(payload.reportId).toBe(report.reportId)
    expect(payload.diagnostics.sessionID).toBe("ses_1")
    expect(payload.sessionExport.status).toBe("ok")
    expect(payload.rendererDiagnostics?.status).toBe("ok")
    expect(payload.rendererDiagnostics?.summary.event_count).toBe(1)
  })

  test("summarizes renderer diagnostics without exposing event payloads", () => {
    const summary = buildProblemReportSummary({
      reportId: "pwr_20260423_abc123",
      generatedAt: "2026-04-23T01:02:03.004Z",
      diagnostics: base.diagnostics,
      reportFileName: "pawwork-problem-report.md",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report.md",
      fullReportStatus: "ready",
      recentErrors: [],
      rendererDiagnostics: base.rendererDiagnostics,
    })

    expect(summary).toContain("Renderer diagnostics: ok, events=1, incidents=0")
    expect(summary).not.toContain("session.action.submit")
  })

  test("builds a short summary without full logs, paths, session export, tool output, or snippets", () => {
    const summary = buildProblemReportSummary({
      reportId: "pwr_20260423_abc123",
      generatedAt: "2026-04-23T01:02:03.004Z",
      diagnostics: base.diagnostics,
      reportFileName: "pawwork-problem-report-20260423-090203-004-abc123.md",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report-20260423-090203-004-abc123.md",
      fullReportStatus: "ready",
      recentErrors: ["[error] launch failed", "[warn] retrying"],
    })

    expect(summary).toContain("PawWork Problem Report Summary")
    expect(summary).toContain("Report ID: pwr_20260423_abc123")
    expect(summary).toContain("Report file: pawwork-problem-report-20260423-090203-004-abc123.md")
    expect(summary).toContain("Full report: ready for manual upload")
    expect(summary).toContain("[error] launch failed")
    expect(summary).not.toContain(base.diagnostics.logPath)
    expect(summary).not.toContain(base.diagnostics.directory)
    expect(summary).not.toContain("line one")
    expect(summary).not.toContain("messages")
    expect(summary.split(/\r?\n/).length).toBeLessThanOrEqual(28)
  })

  test("includes renderer error details in the short summary and full report", () => {
    const rendererError = {
      summary: "PawWork hit a local state problem. storage=pawwork.workspace.project.abc123.dat key=workspace:vcs",
      details: [
        "ChildStoreError: Failed to create persisted cache",
        'cache=vcs, storage=pawwork.workspace.project.abc123.dat, key=workspace:vcs, directory="/Users/test/project"',
        "Caused by:",
        "TypeError: storage init failed",
      ].join("\n"),
    }
    const report = buildProblemReport({ ...base, rendererError })
    const payload = parseProblemReportPayload(report.markdown)
    const summary = buildProblemReportSummary({
      reportId: report.reportId,
      generatedAt: report.generatedAt,
      diagnostics: base.diagnostics,
      reportFileName: "pawwork-problem-report.md",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report.md",
      fullReportStatus: "ready",
      recentErrors: [],
      rendererError,
    })

    expect(payload.rendererError).toEqual(rendererError)
    expect(summary).toContain("Renderer error: PawWork hit a local state problem.")
    expect(summary).toContain("storage=[redacted]")
    expect(summary).toContain("key=[redacted]")
    expect(summary).not.toContain("/Users/test/project")
    expect(summary).not.toContain("pawwork.workspace.project.abc123.dat")
    expect(summary).not.toContain("workspace:vcs")
  })

  test("summary explains summary-only submission when the full report is unavailable", () => {
    const summary = buildProblemReportSummary({
      reportId: "pwr_20260423_failed",
      generatedAt: "2026-04-23T01:02:03.004Z",
      diagnostics: base.diagnostics,
      reportFileName: null,
      reportLocationHint: null,
      fullReportStatus: "failed",
      failureReason: "file_write_failed",
      recentErrors: [],
    })

    expect(summary).toContain("Full report: not generated")
    expect(summary).toContain("Submit this summary without an attachment if needed.")
    expect(summary).toContain("No recent errors found")
  })

  test("summary keeps recent errors to a small single-line set", () => {
    const summary = buildProblemReportSummary({
      reportId: "pwr_20260423_errors",
      generatedAt: "2026-04-23T01:02:03.004Z",
      diagnostics: base.diagnostics,
      reportFileName: "pawwork-problem-report-20260423-090203-004-errors.md",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report-20260423-090203-004-errors.md",
      fullReportStatus: "ready",
      recentErrors: Array.from({ length: 20 }, (_, index) => `[error] failure ${index}\nstack line ${index}`),
    })

    expect(summary).toContain("[error] failure 0")
    expect(summary).toContain("[error] failure 9")
    expect(summary).not.toContain("[error] failure 10")
    expect(summary).not.toContain("stack line")
  })

  test("summary truncates oversized recent error lines", () => {
    const toolOutput = "x".repeat(5_000)
    const summary = buildProblemReportSummary({
      reportId: "pwr_long_errors",
      generatedAt: "2026-04-23T01:02:03.004Z",
      diagnostics: base.diagnostics,
      reportFileName: "pawwork-problem-report-20260423-090203-004-pwr_long_errors.md",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report-20260423-090203-004-pwr_long_errors.md",
      fullReportStatus: "ready",
      recentErrors: [`[error] tool output ${toolOutput}`],
    })

    expect(summary).toContain("[error] tool output")
    expect(summary).toContain("...")
    expect(summary).not.toContain(toolOutput)
    expect(summary.length).toBeLessThan(1_000)
  })

  test("summary omits prompt query and hash content from routes", () => {
    const prompt = "write this exact code snippet ".repeat(200)
    const summary = buildProblemReportSummary({
      reportId: "pwr_prompt_route",
      generatedAt: "2026-04-23T01:02:03.004Z",
      diagnostics: {
        ...base.diagnostics,
        route: `/session/new?prompt=${encodeURIComponent(prompt)}#${"hash".repeat(200)}`,
      },
      reportFileName: "pawwork-problem-report-20260423-090203-004-pwr_prompt_route.md",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report-20260423-090203-004-pwr_prompt_route.md",
      fullReportStatus: "ready",
      recentErrors: [],
    })

    expect(summary).toContain("Route: /session/new")
    expect(summary).not.toContain("prompt=")
    expect(summary).not.toContain(encodeURIComponent(prompt))
    expect(summary).not.toContain("hashhash")
    expect(summary.length).toBeLessThan(1_000)
  })

  test("summary truncates and cleans session ids", () => {
    const longSessionID = `ses_${"x".repeat(500)}`
    const summary = buildProblemReportSummary({
      reportId: "pwr_long_session",
      generatedAt: "2026-04-23T01:02:03.004Z",
      diagnostics: {
        ...base.diagnostics,
        sessionID: `${longSessionID}/C:\\Users\\name\\secret`,
      },
      reportFileName: "pawwork-problem-report-20260423-090203-004-pwr_long_session.md",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report-20260423-090203-004-pwr_long_session.md",
      fullReportStatus: "ready",
      recentErrors: [],
    })

    expect(summary).toContain("Session: ses_")
    expect(summary).toContain("...")
    expect(summary).not.toContain(longSessionID)
    expect(summary).not.toContain("C:\\Users\\name")
  })

  test("summary omits raw Windows paths, spaces, and non-ASCII user directories", () => {
    const summary = buildProblemReportSummary({
      reportId: "pwr_windows_paths",
      generatedAt: "2026-04-23T01:02:03.004Z",
      diagnostics: {
        ...base.diagnostics,
        platform: "win32",
        directory: "C:\\Users\\张 三\\Project Space",
        logPath: "C:\\Users\\张 三\\AppData\\Roaming\\PawWork\\logs\\main.log",
      },
      reportFileName: "pawwork-problem-report-20260423-090203-004-pwr_windows_paths.md",
      reportLocationHint: "%APPDATA%/.../problem-reports/pawwork-problem-report-20260423-090203-004-pwr_windows_paths.md",
      fullReportStatus: "ready",
      recentErrors: ["[error] failed to launch C:\\Users\\张 三\\Project Space\\app.log"],
    })

    expect(summary).toContain("%APPDATA%/.../problem-reports/")
    expect(summary).not.toContain("C:\\Users\\张 三")
    expect(summary).not.toContain("Project Space")
    expect(summary).not.toContain("main.log")
    expect(summary).not.toContain("Space\\app.log")
    expect(summary).not.toContain("app.log")
  })

  test("summary omits Linux, temp, and network local paths from recent errors", () => {
    const summary = buildProblemReportSummary({
      reportId: "pwr_unix_paths",
      generatedAt: "2026-04-23T01:02:03.004Z",
      diagnostics: {
        ...base.diagnostics,
        platform: "linux",
        directory: "/home/alice/workspace/project",
        logPath: "/home/alice/.config/PawWork/logs/main.log",
      },
      reportFileName: "pawwork-problem-report-20260423-090203-004-pwr_unix_paths.md",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report-20260423-090203-004-pwr_unix_paths.md",
      fullReportStatus: "ready",
      recentErrors: [
        "[error] failed reading /home/alice/workspace/project/src/index.ts",
        "[warn] temp output at /tmp/pawwork/session/output.log",
        "[error] network path \\\\server\\share\\alice\\secret.log",
      ],
    })

    expect(summary).toContain("[path]")
    expect(summary).not.toContain("/home/alice")
    expect(summary).not.toContain("/tmp/pawwork")
    expect(summary).not.toContain("\\\\server\\share")
    expect(summary).not.toContain("secret.log")
  })

  test("keeps no-session reports useful", () => {
    const report = buildProblemReport({
      ...base,
      diagnostics: { ...base.diagnostics, sessionID: null },
      sessionExport: { status: "none" },
    })
    const payload = parseProblemReportPayload(report.markdown)
    expect(payload.sessionExport).toEqual({ status: "none" })
    expect(payload.logTail).toContain("line two")
  })

  test("keeps failed export status", () => {
    const report = buildProblemReport({
      ...base,
      sessionExport: { status: "failed", error: "session export failed: 500" },
    })
    const payload = parseProblemReportPayload(report.markdown)
    expect(payload.sessionExport).toEqual({ status: "failed", error: "session export failed: 500" })
  })

  test("truncates oversized failed export errors", () => {
    const report = buildProblemReport(
      {
        ...base,
        logTail: "",
        sessionExport: { status: "failed", error: "session export failed\n".repeat(20_000) },
      },
      { maxBytes: 8_000 },
    )

    expect(Buffer.byteLength(report.markdown, "utf8")).toBeLessThanOrEqual(8_000)
    const payload = parseProblemReportPayload(report.markdown)
    expect(payload.truncation.omittedFailedExportErrorBytes).toBeGreaterThan(0)
    expect(payload.sessionExport.status).toBe("failed")
    if (payload.sessionExport.status === "failed") expect(payload.sessionExport.error.length).toBeLessThan(100_000)
  })

  test("truncates oversized renderer error details to honor max bytes", () => {
    const details = "renderer stack\n".repeat(20_000)
    const report = buildProblemReport(
      {
        ...base,
        logTail: "",
        sessionExport: { status: "none" },
        rendererError: {
          summary: "large renderer error",
          details,
        },
      },
      { maxBytes: 8_000 },
    )

    expect(Buffer.byteLength(report.markdown, "utf8")).toBeLessThanOrEqual(8_000)
    const payload = parseProblemReportPayload(report.markdown)
    expect(payload.rendererError?.summary).toBe("large renderer error")
    expect(payload.rendererError?.details.length).toBeLessThan(details.length)
  })

  test("truncates renderer diagnostics events to honor max bytes", () => {
    const report = buildProblemReport(
      {
        ...base,
        logTail: "",
        sessionExport: { status: "none" },
        rendererDiagnostics: {
          ...base.rendererDiagnostics,
          events: [
            ...Array.from({ length: 50 }, (_, index) => ({
              ...base.rendererDiagnostics.events[0],
              trace_id: `msg_${index}`,
              data: { action: "submit", endpoint_kind: "prompt", prompt_length: index },
            })),
            {
              ...base.rendererDiagnostics.events[0],
              "event.name": "incident.session_scroll_jump_to_top",
              data: { scroll_top: 0, distance_from_bottom: 500, client_height: 400, user_scrolled: false },
            },
          ],
          summary: {
            ...base.rendererDiagnostics.summary,
            event_count: 51,
            incident_count: 1,
          },
        },
      },
      { maxBytes: 5_000 },
    )

    expect(Buffer.byteLength(report.markdown, "utf8")).toBeLessThanOrEqual(5_000)
    const payload = parseProblemReportPayload(report.markdown)
    expect(payload.rendererDiagnostics?.status).toBe("truncated")
    expect(payload.rendererDiagnostics?.truncation).toBeUndefined()
    expect(payload.rendererDiagnostics?.summary.omitted_event_count).toBeGreaterThan(0)
    expect(payload.truncation.omittedRendererDiagnosticsBytes).toBeGreaterThan(0)
  })

  test("sanitizes non-json session export values", () => {
    const circular: Record<string, unknown> = { id: "root" }
    circular.self = circular
    const report = buildProblemReport({
      ...base,
      sessionExport: {
        status: "ok",
        info: { size: 123n, circular },
        messages: [{ body: 456n, circular }],
      },
    })

    const payload = parseProblemReportPayload(report.markdown)
    expect(payload.sessionExport.status).toBe("ok")
    if (payload.sessionExport.status === "ok") {
      expect(payload.sessionExport.info).toEqual({ size: "123", circular: { id: "root", self: "[Circular]" } })
      expect(payload.sessionExport.messages[0]).toEqual({
        body: "456",
        circular: { id: "root", self: "[Circular]" },
      })
    }
  })

  test("enforces max bytes while preserving parseable JSON", () => {
    const report = buildProblemReport(
      {
        ...base,
        logTail: "x".repeat(20_000),
        sessionExport: {
          status: "ok",
          info: base.sessionExport.info,
          messages: Array.from({ length: 200 }, (_, index) => ({
            info: { id: `msg_${index}`, sessionID: "ses_1", role: "assistant" },
            parts: [{ type: "text", text: "y".repeat(1000) }],
          })),
        },
      },
      { maxBytes: 10_000 },
    )

    expect(Buffer.byteLength(report.markdown, "utf8")).toBeLessThanOrEqual(10_000)
    const payload = parseProblemReportPayload(report.markdown)
    expect(payload.truncation.omittedMessages).toBeGreaterThan(0)
  })

  test("omits oversized session info to honor max bytes", () => {
    const report = buildProblemReport(
      {
        ...base,
        logTail: "",
        sessionExport: {
          status: "ok",
          info: { snapshot: "z".repeat(20_000) },
          messages: [],
        },
      },
      { maxBytes: 5_000 },
    )

    expect(Buffer.byteLength(report.markdown, "utf8")).toBeLessThanOrEqual(5_000)
    const payload = parseProblemReportPayload(report.markdown)
    expect(payload.truncation.omittedSessionInfoBytes).toBeGreaterThan(0)
    expect(payload.sessionExport.status).toBe("ok")
    if (payload.sessionExport.status === "ok") expect(payload.sessionExport.info).toBeNull()
  })

  test("rejects invalid max byte limits", () => {
    expect(() => buildProblemReport(base, { maxBytes: Number.NaN })).toThrow("maxBytes must be a positive finite number")
    expect(() => buildProblemReport(base, { maxBytes: 0 })).toThrow("maxBytes must be a positive finite number")
  })

  test("rejects invalid caller-provided report metadata", () => {
    expect(() => buildProblemReport(base, { reportId: "" })).toThrow("reportId must be a non-empty string")
    expect(() => buildProblemReport(base, { reportId: "   " })).toThrow("reportId must be a non-empty string")
    expect(() => buildProblemReport(base, { generatedAt: "not a date" })).toThrow(
      "generatedAt must be a valid ISO timestamp",
    )
    expect(() => buildProblemReport(base, { generatedAt: "2026-04-23" })).toThrow(
      "generatedAt must be a valid ISO timestamp",
    )
    expect(() => buildProblemReport(base, { generatedAt: "2026-04-23T01:02:03Z" })).toThrow(
      "generatedAt must be a valid ISO timestamp",
    )
  })

  test("parses only the first JSON fence", () => {
    const report = [
      "```json",
      JSON.stringify({
        reportVersion: 1,
        reportId: "pwr_fixture",
        generatedAt: new Date().toISOString(),
        diagnostics: base.diagnostics,
        logTail: "",
        sessionExport: { status: "none" },
        truncation: {
          omittedMessages: 0,
          omittedLogBytes: 0,
          omittedSessionInfoBytes: 0,
          omittedFailedExportErrorBytes: 0,
          omittedRendererDiagnosticsBytes: 0,
          omittedDiagnosticsBytes: 0,
        },
      }),
      "```",
      "",
      "```",
      "extra",
      "```",
    ].join("\n")

    expect(parseProblemReportPayload(report).sessionExport.status).toBe("none")
  })

  test("parses CRLF fenced JSON", () => {
    const report = [
      "```json",
      JSON.stringify({
        reportVersion: 1,
        reportId: "pwr_fixture",
        generatedAt: new Date().toISOString(),
        diagnostics: base.diagnostics,
        logTail: "",
        sessionExport: { status: "none" },
        truncation: {
          omittedMessages: 0,
          omittedLogBytes: 0,
          omittedSessionInfoBytes: 0,
          omittedFailedExportErrorBytes: 0,
          omittedRendererDiagnosticsBytes: 0,
          omittedDiagnosticsBytes: 0,
        },
      }),
      "```",
    ].join("\r\n")

    expect(parseProblemReportPayload(report).sessionExport.status).toBe("none")
  })

  test("skips invalid fenced JSON before a valid report", () => {
    const report = [
      "```json",
      "{ invalid",
      "```",
      "```json",
      JSON.stringify({
        reportVersion: 1,
        reportId: "pwr_fixture",
        generatedAt: new Date().toISOString(),
        diagnostics: base.diagnostics,
        logTail: "",
        sessionExport: { status: "none" },
        truncation: {
          omittedMessages: 0,
          omittedLogBytes: 0,
          omittedSessionInfoBytes: 0,
          omittedFailedExportErrorBytes: 0,
          omittedRendererDiagnosticsBytes: 0,
          omittedDiagnosticsBytes: 0,
        },
      }),
      "```",
    ].join("\n")

    expect(parseProblemReportPayload(report).sessionExport.status).toBe("none")
  })

  test("rejects malformed renderer error details", () => {
    const report = [
      "```json",
      JSON.stringify({
        reportVersion: 1,
        reportId: "pwr_fixture",
        generatedAt: new Date().toISOString(),
        diagnostics: base.diagnostics,
        logTail: "",
        rendererError: { summary: "missing details" },
        sessionExport: { status: "none" },
        truncation: {
          omittedMessages: 0,
          omittedLogBytes: 0,
          omittedSessionInfoBytes: 0,
          omittedFailedExportErrorBytes: 0,
          omittedRendererDiagnosticsBytes: 0,
          omittedDiagnosticsBytes: 0,
        },
      }),
      "```",
    ].join("\n")

    expect(() => parseProblemReportPayload(report)).toThrow("Problem report JSON block not found")
  })

  test("rejects fenced JSON that is not a valid problem report payload", () => {
    const report = [
      "```json",
      JSON.stringify({
        reportVersion: 1,
        reportId: "pwr_invalid",
        diagnostics: base.diagnostics,
        logTail: "",
        sessionExport: { status: "none" },
        truncation: {
          omittedMessages: 0,
          omittedLogBytes: 0,
          omittedSessionInfoBytes: 0,
          omittedFailedExportErrorBytes: 0,
          omittedRendererDiagnosticsBytes: 0,
          omittedDiagnosticsBytes: 0,
        },
      }),
      "```",
    ].join("\n")

    expect(() => parseProblemReportPayload(report)).toThrow("Problem report JSON block not found")
  })
})
