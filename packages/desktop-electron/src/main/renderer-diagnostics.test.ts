import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRendererDiagnosticsRecorder,
  DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_MS,
  exportRendererDiagnosticsLog,
  sanitizeRendererDiagnosticEvent,
  selectRendererDiagnosticsSlice,
  type RendererDiagnosticInput,
} from "./renderer-diagnostics"

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

describe("renderer diagnostics sanitizer", () => {
  test("accepts allowlisted scroll fields and drops hostile fields", () => {
    const input: RendererDiagnosticInput = {
      name: "session.scroll.sample",
      level: "info",
      monotonic_ms: 123.5,
      trace_id: "trace_1",
      route_session_id: "ses_route",
      visible_session_id: "ses_visible",
      timeline_session_id: "ses_timeline",
      data: {
        scroll_top: 42,
        scroll_height: 1200,
        client_height: 800,
        distance_from_bottom: 358,
        user_scrolled: false,
        jump_button_visible: true,
        visible_first_message_id: "msg_first",
        visible_last_message_id: "msg_last",
        prompt_text: "do not write me",
        raw_provider_url: "https://api.example.com/token=secret",
        nested: { message_text: "do not write me" },
      },
    }

    const event = sanitizeRendererDiagnosticEvent(input, {
      appLaunchID: "launch_1",
      now: () => new Date("2026-05-02T10:30:12.123Z"),
      windowID: 7,
    })

    expect(event).toMatchObject({
      time: "2026-05-02T10:30:12.123Z",
      monotonic_ms: 123.5,
      level: "info",
      "event.name": "session.scroll.sample",
      app_launch_id: "launch_1",
      window_id: "7",
      trace_id: "trace_1",
      route_session_id: "ses_route",
      visible_session_id: "ses_visible",
      timeline_session_id: "ses_timeline",
      data: {
        scroll_top: 42,
        scroll_height: 1200,
        client_height: 800,
        distance_from_bottom: 358,
        user_scrolled: false,
        jump_button_visible: true,
        visible_first_message_id: "msg_first",
        visible_last_message_id: "msg_last",
      },
    })
    expect(JSON.stringify(event)).not.toContain("prompt_text")
    expect(JSON.stringify(event)).not.toContain("raw_provider_url")
    expect(JSON.stringify(event)).not.toContain("do not write me")
  })

  test("ignores unknown events, malformed input, and oversized payloads", () => {
    expect(
      sanitizeRendererDiagnosticEvent(
        { name: "unknown.event", data: { scroll_top: 1 } },
        { appLaunchID: "launch_1", now: () => new Date("2026-05-02T10:30:12.123Z"), windowID: 1 },
      ),
    ).toBeUndefined()
    expect(
      sanitizeRendererDiagnosticEvent(null, {
        appLaunchID: "launch_1",
        now: () => new Date("2026-05-02T10:30:12.123Z"),
        windowID: 1,
      }),
    ).toBeUndefined()
    expect(
      sanitizeRendererDiagnosticEvent(42, {
        appLaunchID: "launch_1",
        now: () => new Date("2026-05-02T10:30:12.123Z"),
        windowID: 1,
      }),
    ).toBeUndefined()
    expect(
      sanitizeRendererDiagnosticEvent(
        { name: "session.action.submit", data: { prompt_length: 1n } },
        { appLaunchID: "launch_1", now: () => new Date("2026-05-02T10:30:12.123Z"), windowID: 1 },
      ),
    ).toBeUndefined()
    expect(
      sanitizeRendererDiagnosticEvent(
        { name: "session.action.submit", data: { action: "submit_prompt", huge: "x".repeat(9000) } },
        { appLaunchID: "launch_1", now: () => new Date("2026-05-02T10:30:12.123Z"), windowID: 1 },
      ),
    ).toBeUndefined()
  })

  test("drops url-like strings even when they use allowlisted field names", () => {
    const event = sanitizeRendererDiagnosticEvent(
      {
        name: "session.action.submit",
        data: {
          action: "submit_prompt",
          provider: "wss://provider.example.com/v1",
          model: "deepseek-v4-pro",
          endpoint_kind: "api.example.com/v1",
        },
      },
      { appLaunchID: "launch_1", now: () => new Date("2026-05-02T10:30:12.123Z"), windowID: 1 },
    )

    expect(event?.data).toEqual({ action: "submit_prompt", model: "deepseek-v4-pro" })
  })

  test("keeps dotted technical identifiers that are not URLs", () => {
    const event = sanitizeRendererDiagnosticEvent(
      {
        name: "session.action.submit",
        data: {
          action: "submit_prompt",
          provider: "open-router.ai",
          model: "deepseek.v4",
        },
      },
      { appLaunchID: "launch_1", now: () => new Date("2026-05-02T10:30:12.123Z"), windowID: 1 },
    )

    expect(event?.data).toEqual({
      action: "submit_prompt",
      provider: "open-router.ai",
      model: "deepseek.v4",
    })
  })

  test("accepts typed session timeline scroll controller diagnostics", () => {
    const event = sanitizeRendererDiagnosticEvent(
      {
        name: "session.timeline.scroll_controller",
        route_session_id: "ses_route",
        visible_session_id: "ses_visible",
        timeline_session_id: "ses_timeline",
        data: {
          mode_before: "following_latest",
          mode_after: "following_latest",
          intent_type: "submit",
          intent_source: "scroll_view",
          observation_type: "scroll_sample",
          accepted: false,
          recovery: true,
          reason: "submit_restore_latest_after_top_reset",
          anchor_kind: "latest",
          anchor_message_id: "msg_latest",
          submit_origin_mode: "following_latest",
          near_top: true,
          near_bottom: false,
          near_anchor: false,
          session_owner: "ses_owner",
          viewport_owner: "viewport_owner",
          coalesced_count: 2,
          raw_prompt: "do not keep me",
        },
      },
      { appLaunchID: "launch_1", now: () => new Date("2026-05-02T10:30:12.123Z"), windowID: 1 },
    )

    expect(event).toMatchObject({
      "event.name": "session.timeline.scroll_controller",
      route_session_id: "ses_route",
      visible_session_id: "ses_visible",
      timeline_session_id: "ses_timeline",
      data: {
        mode_before: "following_latest",
        mode_after: "following_latest",
        intent_type: "submit",
        intent_source: "scroll_view",
        observation_type: "scroll_sample",
        accepted: false,
        recovery: true,
        reason: "submit_restore_latest_after_top_reset",
        anchor_kind: "latest",
        anchor_message_id: "msg_latest",
        submit_origin_mode: "following_latest",
        near_top: true,
        near_bottom: false,
        near_anchor: false,
        session_owner: "ses_owner",
        viewport_owner: "viewport_owner",
        coalesced_count: 2,
      },
    })
    expect(JSON.stringify(event)).not.toContain("do not keep me")
  })
})

describe("renderer diagnostics recorder", () => {
  test("records JSONL and drops high-frequency duplicate samples", async () => {
    const root = await tempRoot()
    const recorder = createRendererDiagnosticsRecorder({
      root,
      appLaunchID: "launch_1",
      now: () => new Date("2026-05-02T10:30:12.123Z"),
      highFrequencyIntervalMs: 250,
    })

    await recorder.record({ name: "session.scroll.sample", monotonic_ms: 1, data: { scroll_top: 1 } }, { windowID: 1 })
    await recorder.record({ name: "session.scroll.sample", monotonic_ms: 2, data: { scroll_top: 2 } }, { windowID: 1 })
    await recorder.record({ name: "session.action.submit", monotonic_ms: 3, data: { action: "submit_prompt" } }, { windowID: 1 })

    const lines = (await readFile(recorder.path, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])["event.name"]).toBe("session.scroll.sample")
    expect(JSON.parse(lines[1])["event.name"]).toBe("session.action.submit")
  })

  test("rate limit uses main-process time, not renderer-provided monotonic time", async () => {
    const root = await tempRoot()
    const recorder = createRendererDiagnosticsRecorder({
      root,
      appLaunchID: "launch_1",
      highFrequencyIntervalMs: 60_000,
    })

    await recorder.record({ name: "session.scroll.sample", monotonic_ms: 1, data: { scroll_top: 1 } }, { windowID: 1 })
    await recorder.record(
      { name: "session.scroll.sample", monotonic_ms: 999_999, data: { scroll_top: 2 } },
      { windowID: 1 },
    )

    const lines = (await readFile(recorder.path, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(1)
  })

  test("serializes concurrent writes so retention does not lose accepted events", async () => {
    const root = await tempRoot()
    const recorder = createRendererDiagnosticsRecorder({
      root,
      appLaunchID: "launch_1",
      now: () => new Date("2026-05-02T10:30:12.123Z"),
    })

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        recorder.record(
          {
            name: "session.action.submit",
            trace_id: `msg_${index}`,
            data: { action: "submit_prompt", prompt_length: index },
          },
          { windowID: 1 },
        ),
      ),
    )

    const lines = (await readFile(recorder.path, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(20)
    expect(new Set(lines.map((line) => JSON.parse(line).trace_id)).size).toBe(20)
  })

  test("retention keeps recent entries and caps bytes", async () => {
    const root = await tempRoot()
    const recorder = createRendererDiagnosticsRecorder({
      root,
      appLaunchID: "launch_1",
      maxBytes: 260,
      now: () => new Date("2026-05-02T10:30:12.123Z"),
      retentionMs: DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_MS,
    })

    await recorder.record({ name: "session.action.submit", data: { action: "one" } }, { windowID: 1 })
    await recorder.record({ name: "session.action.submit", data: { action: "two" } }, { windowID: 1 })
    await recorder.record({ name: "session.action.submit", data: { action: "three" } }, { windowID: 1 })
    await recorder.flushRetention()

    const content = await readFile(recorder.path, "utf8")
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(260)
    expect(content).toContain("three")
  })

  test("slice keeps matching session transitions and reports truncation", async () => {
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

  test("slice drains queued writes before reading", async () => {
    const root = await tempRoot()
    const recorder = createRendererDiagnosticsRecorder({
      root,
      appLaunchID: "launch_1",
      now: () => new Date("2026-05-02T10:30:12.123Z"),
    })

    const pending = recorder.record(
      {
        name: "session.action.submit",
        route_session_id: "ses_1",
        data: { action: "submit_prompt" },
      },
      { windowID: 1 },
    )
    const slice = await recorder.slice({
      sessionID: "ses_1",
      maxBytes: 1024,
      from: new Date("2026-05-02T10:30:00.000Z"),
      to: new Date("2026-05-02T10:31:00.000Z"),
    })

    await pending
    expect(slice.status).toBe("ok")
    expect(slice.events).toHaveLength(1)
  })

  test("slice re-sanitizes stored JSONL before exporting diagnostics", async () => {
    const root = await tempRoot()
    const recorder = createRendererDiagnosticsRecorder({ root, appLaunchID: "launch_1" })
    await writeFile(
      recorder.path,
      JSON.stringify({
        time: "2026-05-02T10:30:12.123Z",
        level: "warn",
        "event.name": "session.action.submit",
        app_launch_id: "launch_1",
        window_id: "1",
        route_session_id: "ses_1",
        trace_id: "https://example.com/token=secret",
        data: {
          action: "submit_prompt",
          provider: "https://provider.example.com/v1?token=secret",
          model: "deepseek.v4",
          prompt_text: "do not export",
        },
      }) + "\n",
      "utf8",
    )

    const slice = await recorder.slice({
      sessionID: "ses_1",
      maxBytes: 1024,
      from: new Date("2026-05-02T10:30:00.000Z"),
      to: new Date("2026-05-02T10:31:00.000Z"),
    })

    expect(slice.events).toHaveLength(1)
    expect(slice.events[0]).toMatchObject({
      "event.name": "session.action.submit",
      data: {
        action: "submit_prompt",
        model: "deepseek.v4",
      },
    })
    expect(slice.events[0]?.trace_id).toBeUndefined()
    expect(JSON.stringify(slice)).not.toContain("token=secret")
    expect(JSON.stringify(slice)).not.toContain("do not export")
  })

  test("reports missing, disabled, corrupt, and expired statuses without throwing", async () => {
    const root = await tempRoot()
    const missing = createRendererDiagnosticsRecorder({ root, appLaunchID: "launch_1" })
    expect((await missing.slice({ sessionID: "ses_1", maxBytes: 1024 })).status).toBe("missing")

    const disabled = createRendererDiagnosticsRecorder({ root, appLaunchID: "launch_1", disabled: true })
    expect((await disabled.record({ name: "session.action.submit", data: { action: "submit_prompt" } }, { windowID: 1 })).reason).toBe(
      "disabled",
    )
    expect((await disabled.slice({ sessionID: "ses_1", maxBytes: 1024 })).status).toBe("disabled")

    await writeFile(missing.path, "{not json}\n", "utf8")
    expect((await missing.slice({ sessionID: "ses_1", maxBytes: 1024 })).status).toBe("corrupt")

    await writeFile(
      missing.path,
      JSON.stringify({
        time: "2026-05-01T10:30:12.123Z",
        level: "info",
        "event.name": "session.action.submit",
        app_launch_id: "launch_1",
        window_id: "1",
        visible_session_id: "ses_1",
        data: { action: "submit_prompt" },
      }) + "\n",
      "utf8",
    )
    expect(
      (
        await missing.slice({
          sessionID: "ses_1",
          maxBytes: 1024,
          from: new Date("2026-05-02T10:30:00.000Z"),
          to: new Date("2026-05-02T10:31:00.000Z"),
        })
      ).status,
    ).toBe("expired")
  })

  test("recovers slices after a transient write failure", async () => {
    const parent = await tempRoot()
    const root = join(parent, "blocked")
    await writeFile(root, "not a directory", "utf8")
    const recorder = createRendererDiagnosticsRecorder({
      root,
      appLaunchID: "launch_1",
      now: () => new Date("2026-05-02T10:30:12.123Z"),
    })

    expect(
      (await recorder.record({ name: "session.action.submit", data: { action: "submit_prompt" } }, { windowID: 1 }))
        .reason,
    ).toBe("write_failed")
    expect((await recorder.slice({ sessionID: "ses_1", maxBytes: 1024 })).status).toBe("write_failed")

    await rm(root, { force: true })
    expect(
      (
        await recorder.record(
          {
            name: "session.action.submit",
            route_session_id: "ses_1",
            data: { action: "submit_prompt" },
          },
          { windowID: 1 },
        )
      ).ok,
    ).toBe(true)

    const slice = await recorder.slice({
      sessionID: "ses_1",
      maxBytes: 1024,
      from: new Date("2026-05-02T10:30:00.000Z"),
      to: new Date("2026-05-02T10:31:00.000Z"),
    })
    expect(slice.status).toBe("ok")
    expect(slice.events).toHaveLength(1)
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
