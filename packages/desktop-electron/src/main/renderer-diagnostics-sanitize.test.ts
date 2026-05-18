import { describe, expect, test } from "bun:test"
import { sanitizeRendererDiagnosticEvent, type RendererDiagnosticInput } from "./renderer-diagnostics"

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

  test("keeps session abort diagnostics and drops unrelated fields", () => {
    const event = sanitizeRendererDiagnosticEvent(
      {
        name: "session.action.abort",
        route_session_id: "ses_route",
        visible_session_id: "ses_visible",
        timeline_session_id: "ses_timeline",
        data: {
          source: "emptyEnter",
          mode: "soft",
          result: "aborted",
          prompt_text: "do not keep me",
        },
      },
      { appLaunchID: "launch_1", now: () => new Date("2026-05-02T10:30:12.123Z"), windowID: 1 },
    )

    expect(event).toMatchObject({
      "event.name": "session.action.abort",
      route_session_id: "ses_route",
      visible_session_id: "ses_visible",
      timeline_session_id: "ses_timeline",
      data: {
        source: "emptyEnter",
        mode: "soft",
        result: "aborted",
      },
    })
    expect(JSON.stringify(event)).not.toContain("do not keep me")
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
