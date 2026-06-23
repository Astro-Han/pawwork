import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exportRendererDiagnosticsLog, sanitizeRendererDiagnosticEvent, selectRendererDiagnosticsSlice } from "./renderer-diagnostics"

let roots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "pawwork-renderer-diagnostics-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
})

describe("renderer diagnostics slices", () => {
  test("keeps matching session transitions and reports truncation", async () => {
    const events = [
      {
        time: "2026-05-02T10:30:10.000Z",
        level: "info" as const,
        "event.name": "session.identity.transition",
        app_launch_id: "launch_1",
        window_id: "1",
        data: { from_visible_session_id: "ses_old", to_visible_session_id: "ses_target" },
      },
      {
        time: "2026-05-02T10:30:11.000Z",
        level: "warn" as const,
        "event.name": "incident.session_timeline_remount",
        app_launch_id: "launch_1",
        window_id: "1",
        visible_session_id: "ses_target",
        data: { timeline_mount_count: 2, timeline_unmount_count: 1 },
      },
      {
        time: "2026-05-02T10:30:12.000Z",
        level: "info" as const,
        "event.name": "session.scroll.sample",
        app_launch_id: "launch_1",
        window_id: "1",
        visible_session_id: "ses_target",
        data: {
          scroll_top: 10,
          scroll_height: 1200,
          client_height: 800,
          distance_from_bottom: 390,
          payload: "x".repeat(1000),
        },
      },
      {
        time: "2026-05-02T10:30:12.500Z",
        level: "info" as const,
        "event.name": "session.scroll.sample",
        app_launch_id: "launch_1",
        window_id: "2",
        visible_session_id: "ses_other",
        data: { scroll_top: 10 },
      },
    ]

    const slice = selectRendererDiagnosticsSlice(events, {
      sessionID: "ses_target",
      windowID: "1",
      appLaunchID: "launch_1",
      maxBytes: 800,
      now: new Date("2026-05-02T10:30:13.000Z"),
    })

    expect(slice.status).toBe("truncated")
    expect(slice.events.map((event) => event["event.name"])).toContain("incident.session_timeline_remount")
    expect(slice.events.map((event) => event["event.name"])).toContain("session.identity.transition")
    expect(JSON.stringify(slice)).not.toContain("ses_other")
    expect(JSON.stringify(slice)).not.toContain("x".repeat(1000))
  })

  test("bounds a scoped slice to the default lookback, and an explicit `from` widens it", () => {
    // Manual diagnostics triggers usually happen shortly after the incident, so both scoped and unscoped
    // slices use the same bounded ~30-min lookback for minimal collection: a 7-hour-old incident from the
    // same session is NOT pulled in by default, but an explicit `from` opens a wider window when needed.
    const olderIncident = {
      time: "2026-05-02T10:00:00.000Z",
      level: "warn" as const,
      "event.name": "incident.session_timeline_remount",
      app_launch_id: "launch_1",
      window_id: "1",
      visible_session_id: "ses_target",
      data: { timeline_mount_count: 2, timeline_unmount_count: 1 },
    }
    const input = {
      sessionID: "ses_target",
      windowID: "1",
      appLaunchID: "launch_1",
      maxBytes: 10_000,
      now: new Date("2026-05-02T17:00:00.000Z"), // 7h after the event, beyond the default lookback window
    }

    const bounded = selectRendererDiagnosticsSlice([olderIncident], input)
    expect(bounded.events).toHaveLength(0)

    const widened = selectRendererDiagnosticsSlice([olderIncident], { ...input, from: new Date("2026-05-02T09:00:00.000Z") })
    expect(widened.events.map((event) => event["event.name"])).toContain("incident.session_timeline_remount")
  })

  test("global export wraps diagnostics as JSON and caps old events", async () => {
    const root = await tempRoot()
    const source = join(root, "renderer-diagnostics.jsonl")
    const destination = join(root, "exported.json")
    const first = sanitizeRendererDiagnosticEvent(
      {
        name: "session.scroll.sample",
        data: { scroll_top: 1, scroll_height: 100, client_height: 50 },
      },
      { appLaunchID: "launch_1", windowID: 1, now: () => new Date("2026-05-02T10:00:00.000Z") },
    )
    const second = sanitizeRendererDiagnosticEvent(
      {
        name: "incident.session_timeline_remount",
        data: { mounts: 2, unmounts: 1 },
      },
      { appLaunchID: "launch_1", windowID: 1, now: () => new Date("2026-05-02T10:01:00.000Z") },
    )
    await writeFile(source, `${JSON.stringify(first)}\nnot-json\n${JSON.stringify(second)}\n`, "utf8")
    await exportRendererDiagnosticsLog({
      path: source,
      destination,
      maxBytes: JSON.stringify([second]).length + 4,
      now: new Date("2026-05-02T10:02:00.000Z"),
    })
    const exported = JSON.parse(await readFile(destination, "utf8"))
    expect(exported).toMatchObject({
      schema_version: 1,
      format: "pawwork-renderer-diagnostics",
      source: "renderer-diagnostics",
      generated_at: "2026-05-02T10:02:00.000Z",
      diagnostics: {
        status: "truncated",
        event_count: 1,
        incident_count: 1,
        corrupt_line_count: 1,
        omitted_event_count: 1,
      },
    })
    expect(exported.events.map((event: { "event.name": string }) => event["event.name"])).toEqual([
      "incident.session_timeline_remount",
    ])
  })

  test("global export writes a JSON report when the diagnostics log is missing", async () => {
    const root = await tempRoot()
    const destination = join(root, "exported.json")
    await exportRendererDiagnosticsLog({
      path: join(root, "missing.jsonl"),
      destination,
      now: new Date("2026-05-02T10:02:00.000Z"),
    })
    const exported = JSON.parse(await readFile(destination, "utf8"))
    expect(exported).toMatchObject({
      format: "pawwork-renderer-diagnostics",
      diagnostics: {
        status: "missing",
        event_count: 0,
      },
      events: [],
    })
  })
})
