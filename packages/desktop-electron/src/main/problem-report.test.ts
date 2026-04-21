import { describe, expect, test } from "bun:test"
import { buildProblemReport, parseProblemReportPayload } from "./problem-report"

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
}

describe("problem report", () => {
  test("creates markdown with valid fenced JSON", () => {
    const report = buildProblemReport(base)
    expect(report.markdown).toContain("# PawWork Problem Report")
    const payload = parseProblemReportPayload(report.markdown)
    expect(payload.reportVersion).toBe(1)
    expect(payload.diagnostics.sessionID).toBe("ses_1")
    expect(payload.sessionExport.status).toBe("ok")
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

  test("parses only the first JSON fence", () => {
    const report = [
      "```json",
      JSON.stringify({
        reportVersion: 1,
        diagnostics: base.diagnostics,
        logTail: "",
        sessionExport: { status: "none" },
        truncation: { omittedMessages: 0, omittedLogBytes: 0, omittedSessionInfoBytes: 0, omittedDiagnosticsBytes: 0 },
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
        diagnostics: base.diagnostics,
        logTail: "",
        sessionExport: { status: "none" },
        truncation: { omittedMessages: 0, omittedLogBytes: 0, omittedSessionInfoBytes: 0, omittedDiagnosticsBytes: 0 },
      }),
      "```",
    ].join("\r\n")

    expect(parseProblemReportPayload(report).sessionExport.status).toBe("none")
  })
})
