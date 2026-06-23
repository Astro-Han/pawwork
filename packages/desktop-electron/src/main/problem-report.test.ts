import { describe, expect, test } from "bun:test"
import {
  buildProblemReport,
  buildProblemReportSummary,
  capLogTailBytes,
  capMessageParts,
  capSessionMessagesBytes,
  headBytes,
  parseProblemReportPayload,
} from "./problem-report"

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
        time: "2026-04-23T01:02:03.004Z",
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

    const payload = parseProblemReportPayload(report.json)
    expect(report.reportId).toBe("pwr_20260423_abc123")
    expect(report.generatedAt).toBe("2026-04-23T01:02:03.004Z")
    expect(payload.meta.reportId).toBe("pwr_20260423_abc123")
    expect(payload.meta.generatedAt).toBe("2026-04-23T01:02:03.004Z")
  })

  test("creates valid agent-readable JSON", () => {
    const report = buildProblemReport(base)
    expect(report.json).not.toContain("# PawWork Problem Report")
    expect(report.json).not.toContain("```json")
    const payload = parseProblemReportPayload(report.json)
    expect(payload.meta.reportVersion).toBe(1)
    expect(payload.meta.reportId).toBe(report.reportId)
    expect(payload.environment.sessionID).toBe("ses_1")
    expect(payload.session.status).toBe("ok")
    expect(payload.rendererDiagnostics?.status).toBe("ok")
    expect(payload.rendererDiagnostics?.summary.event_count).toBe(1)
  })

  test("creates agent-readable JSON with stable top-level sections and log lines", () => {
    const report = buildProblemReport(
      {
        ...base,
        logTail: ["main: boot", "warn: renderer failed"].join("\n"),
        rendererError: { summary: "Renderer crashed", details: "stack line" },
      },
      {
        reportId: "pwr_agent_readable",
        generatedAt: "2026-06-24T01:02:03.004Z",
      },
    )

    const json = (report as { json?: string }).json
    expect(json).toBeTruthy()
    expect(json).not.toContain("```json")

    const payload = parseProblemReportPayload(json ?? "")
    expect(Object.keys(payload)).toEqual([
      "meta",
      "environment",
      "error",
      "recentErrors",
      "session",
      "rendererDiagnostics",
      "logTail",
    ])
    expect(payload.meta.reportId).toBe("pwr_agent_readable")
    expect(payload.meta.truncation.omittedLogBytes).toBe(0)
    expect(payload.environment.sessionID).toBe("ses_1")
    expect(payload.error?.summary).toBe("Renderer crashed")
    expect(payload.recentErrors).toEqual(["warn: renderer failed"])
    expect(payload.logTail.at(-1)).toBe("warn: renderer failed")
  })

  test("summarizes renderer diagnostics without exposing event payloads", () => {
    const summary = buildProblemReportSummary({
      reportId: "pwr_20260423_abc123",
      generatedAt: "2026-04-23T01:02:03.004Z",
      diagnostics: base.diagnostics,
      reportFileName: "pawwork-problem-report.json",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report.json",
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
      reportFileName: "pawwork-problem-report-20260423-090203-004-abc123.json",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report-20260423-090203-004-abc123.json",
      fullReportStatus: "ready",
      recentErrors: ["[error] launch failed", "[warn] retrying"],
    })

    expect(summary).toContain("PawWork Problem Report Summary")
    expect(summary).toContain("Report ID: pwr_20260423_abc123")
    expect(summary).toContain("Report file: pawwork-problem-report-20260423-090203-004-abc123.json")
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
    const payload = parseProblemReportPayload(report.json)
    const summary = buildProblemReportSummary({
      reportId: report.reportId,
      generatedAt: report.generatedAt,
      diagnostics: base.diagnostics,
      reportFileName: "pawwork-problem-report.json",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report.json",
      fullReportStatus: "ready",
      recentErrors: [],
      rendererError,
    })

    // The full report now redacts the same secret/path shapes as the summary (PR1), so the
    // uploaded file no longer carries raw credentials or local paths in rendererError.
    expect(payload.error?.summary).toContain("storage=[redacted]")
    expect(payload.error?.summary).toContain("key=[redacted]")
    expect(report.json).not.toContain("pawwork.workspace.project.abc123.dat")
    expect(report.json).not.toContain("workspace:vcs")
    expect(report.json).not.toContain("/Users/test/project")
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
      reportFileName: "pawwork-problem-report-20260423-090203-004-errors.json",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report-20260423-090203-004-errors.json",
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
      reportFileName: "pawwork-problem-report-20260423-090203-004-pwr_long_errors.json",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report-20260423-090203-004-pwr_long_errors.json",
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
      reportFileName: "pawwork-problem-report-20260423-090203-004-pwr_prompt_route.json",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report-20260423-090203-004-pwr_prompt_route.json",
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
      reportFileName: "pawwork-problem-report-20260423-090203-004-pwr_long_session.json",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report-20260423-090203-004-pwr_long_session.json",
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
      reportFileName: "pawwork-problem-report-20260423-090203-004-pwr_windows_paths.json",
      reportLocationHint: "%APPDATA%/.../problem-reports/pawwork-problem-report-20260423-090203-004-pwr_windows_paths.json",
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
      reportFileName: "pawwork-problem-report-20260423-090203-004-pwr_unix_paths.json",
      reportLocationHint: "PawWork app data/.../problem-reports/pawwork-problem-report-20260423-090203-004-pwr_unix_paths.json",
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

  test("summary scrubs the bare OS username and non-allowlisted home via shared redactTerms", () => {
    // The summary is the same outbound channel as the full report, so it must apply the caller's
    // exact runtime terms. Under a non-allowlisted root, only the exact term catches the leak — the
    // path regex (allowlisted roots only) does not, and the username is a bare word no regex infers.
    const summary = buildProblemReportSummary({
      reportId: "pwr_terms",
      generatedAt: "2026-04-23T01:02:03.004Z",
      diagnostics: base.diagnostics,
      reportFileName: "r.json",
      reportLocationHint: "hint",
      fullReportStatus: "ready",
      recentErrors: [
        "[error] failed reading /customroot/zoe/project/app.ts",
        "[warn] user zoe could not write cache",
      ],
      rendererError: { summary: "crash under /customroot/zoe/project", details: "" },
      redactTerms: ["/customroot/zoe", "zoe"],
    })

    expect(summary).not.toContain("zoe")
    expect(summary).not.toContain("/customroot/zoe")
  })

  test("summary redacts a short non-ASCII username and identity-bearing report metadata", () => {
    // A 1–2 char CJK username slips past JS \b word boundaries, and the report file/location were
    // inserted raw — both must be scrubbed before the summary hits the clipboard.
    const summary = buildProblemReportSummary({
      reportId: "pwr_cjk",
      generatedAt: "2026-04-23T01:02:03.004Z",
      diagnostics: base.diagnostics,
      reportFileName: "problem.json",
      reportLocationHint: "/customroot/山田/problem-reports/problem.json",
      fullReportStatus: "ready",
      recentErrors: ["[error] failed for user 山田"],
      rendererError: { summary: "crash for 山田", details: "" },
      redactTerms: ["山田"],
    })

    expect(summary).not.toContain("山田")
    expect(summary).not.toContain("/customroot/山田")
  })

  test("keeps no-session reports useful", () => {
    const report = buildProblemReport({
      ...base,
      diagnostics: { ...base.diagnostics, sessionID: null },
      sessionExport: { status: "none" },
    })
    const payload = parseProblemReportPayload(report.json)
    expect(payload.session).toEqual({ status: "none" })
    expect(payload.logTail).toContain("line two")
  })

  test("keeps failed export status", () => {
    const report = buildProblemReport({
      ...base,
      sessionExport: { status: "failed", error: "session export failed: 500" },
    })
    const payload = parseProblemReportPayload(report.json)
    expect(payload.session).toEqual({ status: "failed", error: "session export failed: 500" })
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

    expect(Buffer.byteLength(report.json, "utf8")).toBeLessThanOrEqual(8_000)
    const payload = parseProblemReportPayload(report.json)
    expect(payload.meta.truncation.omittedFailedExportErrorBytes).toBeGreaterThan(0)
    expect(payload.session.status).toBe("failed")
    if (payload.session.status === "failed") expect(payload.session.error.length).toBeLessThan(100_000)
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

    expect(Buffer.byteLength(report.json, "utf8")).toBeLessThanOrEqual(8_000)
    const payload = parseProblemReportPayload(report.json)
    expect(payload.error?.summary).toBe("large renderer error")
    expect(payload.error?.details.length).toBeLessThan(details.length)
    // The ledger reflects what the overall ladder removed too, not only the component-budget cut.
    expect(payload.meta.truncation.omittedRendererErrorBytes).toBeGreaterThan(0)
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

    expect(Buffer.byteLength(report.json, "utf8")).toBeLessThanOrEqual(5_000)
    const payload = parseProblemReportPayload(report.json)
    expect(payload.rendererDiagnostics?.status).toBe("truncated")
    expect(payload.rendererDiagnostics?.truncation).toBeUndefined()
    expect(payload.rendererDiagnostics?.summary.omitted_event_count).toBeGreaterThan(0)
    expect(payload.meta.truncation.omittedRendererDiagnosticsBytes).toBeGreaterThan(0)
  })

  test("drains all-protected renderer diagnostics to fit a tight max bytes (no throw)", () => {
    const incident = {
      ...base.rendererDiagnostics.events[0],
      "event.name": "incident.session_timeline_remount",
      data: { mount_count: 2, unmount_count: 1, note: "x".repeat(200) },
    }
    const report = buildProblemReport(
      {
        ...base,
        logTail: "",
        sessionExport: { status: "none" },
        rendererDiagnostics: {
          ...base.rendererDiagnostics,
          events: Array.from({ length: 40 }, (_, index) => ({ ...incident, trace_id: `inc_${index}` })),
          summary: { ...base.rendererDiagnostics.summary, event_count: 40, incident_count: 40 },
        },
      },
      { maxBytes: 5_000 },
    )

    // Every event is a protected incident, yet the slice still drains to fit. The old fallback broke on
    // the first protected event, so the report would have exceeded maxBytes (or thrown) here.
    expect(Buffer.byteLength(report.json, "utf8")).toBeLessThanOrEqual(5_000)
    const payload = parseProblemReportPayload(report.json)
    expect(payload.rendererDiagnostics?.status).toBe("truncated")
    expect(payload.rendererDiagnostics?.summary.omitted_event_count).toBeGreaterThan(0)
    expect(payload.meta.truncation.omittedRendererDiagnosticsBytes).toBeGreaterThan(0)
  })

  test("re-bounds oversized renderer diagnostics to the component budget below the overall limit", () => {
    // 1.2 MB of events — over the 1 MB renderer-diagnostics component budget but well under the 5 MB
    // overall limit, so only the component cap (not the overall ladder) can have trimmed them.
    const big = {
      ...base.rendererDiagnostics.events[0],
      data: { action: "submit", endpoint_kind: "prompt", blob: "x".repeat(20_000) },
    }
    const report = buildProblemReport({
      ...base,
      rendererDiagnostics: {
        ...base.rendererDiagnostics,
        events: Array.from({ length: 60 }, (_, index) => ({ ...big, trace_id: `e_${index}` })),
        summary: { ...base.rendererDiagnostics.summary, event_count: 60 },
      },
    })

    const payload = parseProblemReportPayload(report.json)
    expect(payload.meta.truncation.omittedRendererDiagnosticsBytes).toBeGreaterThan(0)
    expect(payload.rendererDiagnostics?.summary.omitted_event_count).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(payload.rendererDiagnostics?.events ?? []), "utf8")).toBeLessThanOrEqual(
      1024 * 1024,
    )
  })

  test("sanitizes non-json session export values", () => {
    const circular: Record<string, unknown> = { id: "root" }
    circular.self = circular
    const report = buildProblemReport({
      ...base,
      sessionExport: {
        status: "ok",
        // Both info and executionContext are field allowlists: top-level `size` and executionContext's
        // `build`/`circular` are unknown fields and dropped; the kept `activeDirectory` is shape-tokened.
        info: { id: "ses_1", size: 123n, executionContext: { activeDirectory: "/Users/x/p", build: 789n, circular } },
        messages: [{ body: 456n, circular }],
      },
    })

    const payload = parseProblemReportPayload(report.json)
    expect(payload.session.status).toBe("ok")
    if (payload.session.status === "ok") {
      expect(payload.session.info).toEqual({
        id: "ses_1",
        executionContext: { activeDirectory: "[path]" },
      })
      // A non-{info,parts} message shape is reported, not passed through, so it cannot smuggle
      // raw content into the report (PR1 structure-aware allowlist).
      const message = payload.session.messages[0] as { unrecognized?: boolean; bytes?: number }
      expect(message.unrecognized).toBe(true)
      expect(message.bytes).toBeGreaterThan(0)
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

    expect(Buffer.byteLength(report.json, "utf8")).toBeLessThanOrEqual(10_000)
    const payload = parseProblemReportPayload(report.json)
    expect(payload.meta.truncation.omittedMessages).toBeGreaterThan(0)
  })

  test("omits oversized session info to honor max bytes", () => {
    const report = buildProblemReport(
      {
        ...base,
        logTail: "",
        sessionExport: {
          status: "ok",
          // Bulk lives in the capped title: even after the per-field cap it stays large enough to
          // exceed this small budget, so the omission ladder still has session info to drop.
          info: { title: "z".repeat(20_000) },
          messages: [],
        },
      },
      { maxBytes: 3_000 },
    )

    expect(Buffer.byteLength(report.json, "utf8")).toBeLessThanOrEqual(5_000)
    const payload = parseProblemReportPayload(report.json)
    expect(payload.meta.truncation.omittedSessionInfoBytes).toBeGreaterThan(0)
    expect(payload.session.status).toBe("ok")
    if (payload.session.status === "ok") expect(payload.session.info).toBeNull()
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

  test("parses pure JSON payloads", () => {
    const report = buildProblemReport({ ...base, sessionExport: { status: "none" } }).json

    expect(parseProblemReportPayload(report).session.status).toBe("none")
  })

  test("rejects legacy markdown fenced JSON reports", () => {
    const report = ["# PawWork Problem Report", "", "```json", buildProblemReport(base).json, "```"].join("\n")

    expect(() => parseProblemReportPayload(report)).toThrow("Problem report JSON payload not found")
  })

  test("rejects malformed renderer error details", () => {
    const payload = parseProblemReportPayload(buildProblemReport({ ...base, sessionExport: { status: "none" } }).json)
    const report = JSON.stringify({ ...payload, error: { summary: "missing details" } })

    expect(() => parseProblemReportPayload(report)).toThrow("Problem report JSON payload not found")
  })

  test("rejects JSON that is not a valid problem report payload", () => {
    const report = JSON.stringify({
      meta: { reportVersion: 1, reportId: "pwr_invalid" },
      environment: base.diagnostics,
      error: null,
      recentErrors: [],
      session: { status: "none" },
      rendererDiagnostics: null,
      logTail: [],
    })

    expect(() => parseProblemReportPayload(report)).toThrow("Problem report JSON payload not found")
  })
})

// The size caps live in pure, exported helpers so their small-budget edge cases can be exercised
// directly with tiny inputs, instead of forcing a production `budgets` override that only tests used.
describe("component budgets — pure helpers", () => {
  test("capLogTailBytes keeps the most recent lines and drops the oldest", () => {
    const lines = ["OLDEST_LINE", ...Array.from({ length: 500 }, (_, i) => `log line ${i}`), "NEWEST_LINE"]
    const result = capLogTailBytes(lines.join("\n"), 200)
    expect(Buffer.byteLength(result.value, "utf8")).toBeLessThanOrEqual(200)
    expect(result.omittedBytes).toBeGreaterThan(0)
    expect(result.value).toContain("NEWEST_LINE")
    expect(result.value).not.toContain("OLDEST_LINE")
  })

  test("capLogTailBytes keeps the recent tail of an oversized single line that ends in a newline", () => {
    // A trailing newline leaves an empty last "line"; the byte-accurate fallback must still keep bytes.
    const result = capLogTailBytes(`${"X".repeat(2_000)}\n`, 1_000)
    expect(result.value.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(result.value, "utf8")).toBeLessThanOrEqual(1_000)
    expect(result.omittedBytes).toBeGreaterThan(0)
  })

  test("capLogTailBytes byte-bounds a single oversized line without splitting a multibyte char", () => {
    const result = capLogTailBytes("é".repeat(5_000), 999)
    expect(Buffer.byteLength(result.value, "utf8")).toBeLessThanOrEqual(999)
    expect(result.value).not.toContain("�")
    expect(result.omittedBytes).toBeGreaterThan(0)
  })

  test("headBytes keeps the head within the byte budget without splitting a multibyte char", () => {
    const head = headBytes("é".repeat(5_000), 999)
    expect(Buffer.byteLength(head, "utf8")).toBeLessThanOrEqual(999)
    expect(head).not.toContain("�")
    expect(head.startsWith("é")).toBe(true)
  })

  test("capMessageParts keeps the LATEST parts of an oversized message, trimming the oldest", () => {
    const parts = Array.from({ length: 200 }, (_, i) => ({ id: `p_${i}`, type: "text", text: `part ${i} ${"x".repeat(500)}` }))
    const message = { info: { id: "msg_big", role: "assistant" }, parts }
    const result = capMessageParts(message, 4_000)
    expect(Buffer.byteLength(JSON.stringify(result.value), "utf8")).toBeLessThanOrEqual(4_000)
    expect(result.omittedBytes).toBeGreaterThan(0)
    expect((result.value as { omittedParts?: number }).omittedParts).toBeGreaterThan(0)
    // Keeps the end of the turn (the tool output / error nearest the failure), trimming the start.
    expect(JSON.stringify(result.value)).toContain("part 199 ")
    expect(JSON.stringify(result.value)).not.toContain("part 0 ")
  })

  test("capMessageParts reduces a message whose info alone overflows to an identity stub", () => {
    const message = { info: { id: "msg_big", role: "user", time: { created: 1, blob: "z".repeat(40_000) } }, parts: [] }
    const result = capMessageParts(message, 2_000)
    expect(Buffer.byteLength(JSON.stringify(result.value), "utf8")).toBeLessThanOrEqual(2_000)
    // The oversized info was reduced to a stub rather than smuggled past the budget.
    expect(JSON.stringify(result.value)).not.toContain("z".repeat(100))
    expect((result.value as { oversized?: boolean }).oversized).toBe(true)
  })

  test("capSessionMessagesBytes drops the oldest messages, keeping the most recent", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      info: { id: `msg_${i}`, role: "user", time: { created: i } },
      parts: [{ type: "text", text: `${i === 0 ? "OLDESTMSG " : i === 29 ? "NEWESTMSG " : ""}body ${"x".repeat(200)}` }],
    }))
    const result = capSessionMessagesBytes(messages, 1_500)
    expect(result.omittedMessages).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(result.messages), "utf8")).toBeLessThanOrEqual(1_500)
    expect(JSON.stringify(result.messages)).toContain("NEWESTMSG")
    expect(JSON.stringify(result.messages)).not.toContain("OLDESTMSG")
  })

  test("capSessionMessagesBytes is a hard cap: drops even the newest message that does not fit", () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      info: { id: `msg_${i}`, role: "user", time: { created: i } },
      parts: [{ type: "text", text: `body ${i}` }],
    }))
    const result = capSessionMessagesBytes(messages, 10)
    expect(Buffer.byteLength(JSON.stringify(result.messages), "utf8")).toBeLessThanOrEqual(10)
    expect(result.omittedMessages).toBe(5)
  })
})

// A few end-to-end checks that the helpers above are actually wired into buildProblemReport with the
// real default budgets (1 MB log / 1 MB session / 256 KB per message / 64 KB per renderer-error field).
describe("component budgets — wired into buildProblemReport", () => {
  test("caps the log tail to the default budget, keeping the most recent lines", () => {
    const lines = ["OLDEST_LINE", ...Array.from({ length: 150_000 }, () => "log line"), "NEWEST_LINE"]
    const payload = parseProblemReportPayload(buildProblemReport({ ...base, logTail: lines.join("\n") }).json)
    expect(Buffer.byteLength(payload.logTail.join("\n"), "utf8")).toBeLessThanOrEqual(1024 * 1024)
    expect(payload.meta.truncation.omittedLogBytes).toBeGreaterThan(0)
    expect(payload.logTail).toContain("NEWEST_LINE")
    expect(payload.logTail).not.toContain("OLDEST_LINE")
  })

  test("part-trims a single oversized message to the per-message budget, keeping its latest parts", () => {
    const parts = Array.from({ length: 200 }, (_, i) => ({ id: `p_${i}`, type: "text", text: `part ${i} ${"x".repeat(2_000)}` }))
    const messages = [{ info: { id: "msg_big", sessionID: "ses_1", role: "assistant", time: { created: 1 } }, parts }]
    const payload = parseProblemReportPayload(
      buildProblemReport({ ...base, sessionExport: { status: "ok", info: { id: "ses_1", title: "t" }, messages } }).json,
    )
    const kept = payload.session.status === "ok" ? payload.session.messages : []
    expect(kept.length).toBe(1)
    const message = kept[0] as { omittedParts?: number }
    expect(message.omittedParts).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(message), "utf8")).toBeLessThanOrEqual(256 * 1024)
    // The latest parts (nearest the failure) survive; the start of the turn is trimmed.
    expect(JSON.stringify(message)).toContain("part 199 ")
    expect(JSON.stringify(message)).not.toContain("part 0 ")
    expect(payload.meta.truncation.omittedMessagePartsBytes).toBeGreaterThan(0)
  })

  test("byte-caps the stub identity so an oversized id can't escape under default budgets", () => {
    const messages = [
      { info: { id: `msg_${"x".repeat(1_200_000)}`, sessionID: "ses_1", role: "user" }, parts: [{ type: "text", text: "b" }] },
    ]
    const report = buildProblemReport({
      ...base,
      sessionExport: { status: "ok", info: { id: "ses_1", title: "t" }, messages },
    })

    const payload = parseProblemReportPayload(report.json)
    const kept = payload.session.status === "ok" ? payload.session.messages : []
    // Even the stub's id is byte-capped, so the whole session stays well under the default budget.
    expect(Buffer.byteLength(JSON.stringify(kept), "utf8")).toBeLessThanOrEqual(4_096)
    expect((kept[0] as { oversized?: boolean }).oversized).toBe(true)
  })

  test("caps both the renderer error summary and details to the default budget", () => {
    // summary derives from error.message, which an API error can balloon, so both fields are budgeted.
    const report = buildProblemReport({
      ...base,
      rendererError: { summary: `boom ${"S".repeat(100_000)}`, details: "stack frame\n".repeat(20_000) },
    })

    const payload = parseProblemReportPayload(report.json)
    expect(Buffer.byteLength(payload.error?.summary ?? "", "utf8")).toBeLessThanOrEqual(64 * 1024)
    expect(Buffer.byteLength(payload.error?.details ?? "", "utf8")).toBeLessThanOrEqual(64 * 1024)
    // Both keep the head (the error message + top of the stack), the useful part of an error.
    expect(payload.error?.summary.startsWith("boom ")).toBe(true)
    expect(payload.error?.details.startsWith("stack frame")).toBe(true)
    expect(payload.meta.truncation.omittedRendererErrorBytes).toBeGreaterThan(0)
  })

  test("does not count part-trim bytes for a message the overall ladder later drops whole", () => {
    const bigParts = Array.from({ length: 200 }, (_, i) => ({
      id: `p_${i}`,
      sessionID: "ses_1",
      messageID: "msg_old",
      type: "text",
      text: `part ${i} ${"x".repeat(2_000)}`,
    }))
    const messages = [
      { info: { id: "msg_old", sessionID: "ses_1", role: "assistant", time: { created: 1 } }, parts: bigParts },
      { info: { id: "msg_new", sessionID: "ses_1", role: "user", time: { created: 2 } }, parts: [{ type: "text", text: "hi" }] },
    ]
    const report = buildProblemReport(
      { ...base, sessionExport: { status: "ok", info: { id: "ses_1", title: "t" }, messages } },
      // msg_old is part-trimmed to the 256 KB per-message default but survives the session cap; a small
      // overall maxBytes then drops it whole in the fallback ladder. Its trimmed bytes must leave the ledger.
      { maxBytes: 10_000 },
    )

    const payload = parseProblemReportPayload(report.json)
    const kept = payload.session.status === "ok" ? payload.session.messages : []
    expect(JSON.stringify(kept)).toContain("msg_new")
    expect(JSON.stringify(kept)).not.toContain("msg_old")
    expect(payload.meta.truncation.omittedMessages).toBeGreaterThan(0)
    // The dropped message's part-trim is not double-counted; the surviving message had no trim.
    expect(payload.meta.truncation.omittedMessagePartsBytes).toBe(0)
  })

  test("leaves a small report untouched under default budgets", () => {
    const payload = parseProblemReportPayload(buildProblemReport(base).json)
    expect(payload.meta.truncation.omittedLogBytes).toBe(0)
    expect(payload.meta.truncation.omittedMessages).toBe(0)
    expect(payload.meta.truncation.omittedRendererErrorBytes).toBe(0)
  })
})
