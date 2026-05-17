import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRendererDiagnosticsRecorder,
  DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_MS,
} from "./renderer-diagnostics"

let roots: string[] = []
const posixPermissionsTest = process.platform === "win32" ? test.skip : test

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "pawwork-renderer-diagnostics-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots = []
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

  test("drops high-frequency duplicate scroll controller diagnostics", async () => {
    const root = await tempRoot()
    const recorder = createRendererDiagnosticsRecorder({
      root,
      appLaunchID: "launch_1",
      now: () => new Date("2026-05-02T10:30:12.123Z"),
      highFrequencyIntervalMs: 250,
    })

    await recorder.record(
      {
        name: "session.timeline.scroll_controller",
        monotonic_ms: 1,
        data: { intent_type: "wheel_scroll", reason: "weak_scroll_observed" },
      },
      { windowID: 1 },
    )
    await recorder.record(
      {
        name: "session.timeline.scroll_controller",
        monotonic_ms: 2,
        data: { intent_type: "wheel_scroll", reason: "weak_scroll_observed" },
      },
      { windowID: 1 },
    )
    await recorder.record({ name: "session.action.submit", monotonic_ms: 3, data: { action: "submit_prompt" } }, { windowID: 1 })

    const lines = (await readFile(recorder.path, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])["event.name"]).toBe("session.timeline.scroll_controller")
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

  test("retention leaves headroom below the byte cap", async () => {
    const root = await tempRoot()
    const maxBytes = 1200
    const recorder = createRendererDiagnosticsRecorder({
      root,
      appLaunchID: "launch_1",
      maxBytes,
      now: () => new Date("2026-05-02T10:30:12.123Z"),
      retentionMs: DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_MS,
    })

    for (const index of Array.from({ length: 12 }, (_, value) => value)) {
      await recorder.record(
        {
          name: "session.action.submit",
          trace_id: `msg_${index}`,
          data: {
            action: "submit_prompt",
            provider: `provider-${index}`,
            model: "deepseek.v4",
            prompt_length: index,
          },
        },
        { windowID: 1 },
      )
    }
    await recorder.flushRetention()

    const content = await readFile(recorder.path, "utf8")
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(Math.floor(maxBytes * 0.8))
    expect(content).toContain("msg_11")
  })

  posixPermissionsTest("retention keeps the log intact when the existing file cannot be read", async () => {
    const root = await tempRoot()
    const recorder = createRendererDiagnosticsRecorder({
      root,
      appLaunchID: "launch_1",
      maxBytes: 120,
      now: () => new Date("2026-05-02T10:30:12.123Z"),
    })
    const existing = `${JSON.stringify({
      time: "2026-05-02T10:30:12.123Z",
      level: "info",
      "event.name": "session.action.submit",
      app_launch_id: "launch_1",
      window_id: "1",
      data: { action: "submit_prompt" },
    })}\n`
    await writeFile(recorder.path, existing, "utf8")
    await chmod(recorder.path, 0)

    await recorder.flushRetention()

    await chmod(recorder.path, 0o600)
    expect(await readFile(recorder.path, "utf8")).toBe(existing)
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

})
