import { describe, expect, test } from "bun:test"
import {
  RUNTIME_CLS_PRIMARY_SHIFT_THRESHOLD,
  classifyRuntimeClsSource,
  collectRuntimeClsFailures,
  formatRuntimeClsFailure,
  type RuntimeClsRect,
} from "./runtime-cls-probe"

const rect = (input: Partial<RuntimeClsRect> = {}): RuntimeClsRect => ({
  x: input.x ?? 20,
  y: input.y ?? 120,
  width: input.width ?? 640,
  height: input.height ?? 120,
  top: input.top ?? input.y ?? 120,
  right: input.right ?? (input.x ?? 20) + (input.width ?? 640),
  bottom: input.bottom ?? (input.y ?? 120) + (input.height ?? 120),
  left: input.left ?? input.x ?? 20,
})

function setRect(element: Element, value: RuntimeClsRect) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ ...value, toJSON: () => value }),
  })
}

function buildTurnFixture(input?: { before?: RuntimeClsRect; after?: RuntimeClsRect }) {
  document.body.innerHTML = [
    '<div data-message-id="msg-1">',
    '  <div data-component="session-turn">',
    '    <div data-slot="session-turn-assistant-content">',
    '      <div data-component="markdown">visible assistant markdown</div>',
    "    </div>",
    "  </div>",
    "</div>",
  ].join("")

  const message = document.querySelector('[data-message-id="msg-1"]')!
  const turn = document.querySelector('[data-component="session-turn"]')!
  const assistant = document.querySelector('[data-slot="session-turn-assistant-content"]')!
  const markdown = document.querySelector('[data-component="markdown"]')!
  const before = input?.before ?? rect()
  const after = input?.after ?? rect({ y: before.y + 12, top: before.top + 12, bottom: before.bottom + 12 })

  setRect(message, after)
  setRect(turn, after)
  setRect(assistant, rect({ y: after.y + 24, top: after.top + 24, bottom: after.top + 64 }))
  setRect(markdown, rect({ y: after.y + 32, top: after.top + 32, bottom: after.top + 72 }))

  return { message, turn, assistant, markdown, before, after }
}

describe("runtime CLS source classifier", () => {
  test("classifies a message wrapper source as a primary failure source", () => {
    const { message, before } = buildTurnFixture()

    const result = classifyRuntimeClsSource(message, {
      viewportHeight: 720,
      primaryBeforeRects: new Map([[message, before]]),
    })

    expect(result.kind).toBe("primary-message-wrapper")
    expect(result.primaryAncestor?.label).toBe('[data-message-id="msg-1"]')
  })

  test("classifies a direct session turn source as a primary failure source", () => {
    const { turn, before } = buildTurnFixture()

    const result = classifyRuntimeClsSource(turn, {
      viewportHeight: 720,
      primaryBeforeRects: new Map([[turn, before]]),
    })

    expect(result.kind).toBe("primary-turn")
    expect(result.primaryAncestor?.label).toBe('[data-component="session-turn"]')
  })

  test("promotes assistant descendants inside visible primary ancestors to primary-turn-descendant", () => {
    const { markdown, turn, before } = buildTurnFixture()

    const result = classifyRuntimeClsSource(markdown, {
      viewportHeight: 720,
      primaryBeforeRects: new Map([[turn, before]]),
    })

    expect(result.kind).toBe("primary-turn-descendant")
    expect(result.source.label).toBe('[data-component="markdown"]')
    expect(result.primaryAncestor?.label).toBe('[data-component="session-turn"]')
    expect(result.primaryAncestor?.beforeRect).toEqual(before)
    expect(result.primaryAncestor?.afterRect).toEqual(rect({ y: 132, top: 132, bottom: 252 }))
  })

  test("keeps assistant descendants as residual when the primary ancestor was not visible before and after", () => {
    const before = rect({ y: -280, top: -280, bottom: -160 })
    const after = rect({ y: -260, top: -260, bottom: -140 })
    const { markdown, turn } = buildTurnFixture({ before, after })

    const result = classifyRuntimeClsSource(markdown, {
      viewportHeight: 720,
      primaryBeforeRects: new Map([[turn, before]]),
    })

    expect(result.kind).toBe("residual-assistant-message")
  })

  test("classifies dock sources as diagnostics instead of primary failures", () => {
    document.body.innerHTML = '<div data-component="session-prompt-dock"><div data-slot="question-options"></div></div>'
    const dockChild = document.querySelector('[data-slot="question-options"]')!

    const result = classifyRuntimeClsSource(dockChild, { viewportHeight: 720, primaryBeforeRects: new Map() })

    expect(result.kind).toBe("dock-or-scroll-recovery")
  })
})

describe("runtime CLS failure threshold", () => {
  test("fails only single-entry large primary timeline shifts over the absolute threshold", () => {
    const { markdown, turn, before } = buildTurnFixture()
    const primarySource = classifyRuntimeClsSource(markdown, {
      viewportHeight: 720,
      primaryBeforeRects: new Map([[turn, before]]),
    })

    expect(RUNTIME_CLS_PRIMARY_SHIFT_THRESHOLD).toBe(0.02)
    expect(
      collectRuntimeClsFailures([
        { at: 1, value: RUNTIME_CLS_PRIMARY_SHIFT_THRESHOLD, hadRecentInput: true, sources: [primarySource] },
        { at: 2, value: RUNTIME_CLS_PRIMARY_SHIFT_THRESHOLD + 0.001, hadRecentInput: true, sources: [primarySource] },
      ]),
    ).toEqual([{ at: 2, value: 0.021, hadRecentInput: true, sources: [primarySource] }])
  })
})

describe("runtime CLS failure diagnostics", () => {
  test("prints action, value, source, primary ancestor, scroll metrics, render mode, and row counts", () => {
    const { markdown, turn, before } = buildTurnFixture()
    const source = classifyRuntimeClsSource(markdown, {
      viewportHeight: 720,
      primaryBeforeRects: new Map([[turn, before]]),
    })

    const message = formatRuntimeClsFailure({
      action: "composer-growth",
      entries: [{ at: 12, value: 0.031, hadRecentInput: true, sources: [source] }],
      snapshot: {
        targetMessageID: "msg-1",
        renderMode: "virtualized",
        totalRows: 104,
        mountedRows: 24,
        scrollBefore: { scrollTop: 1200, scrollHeight: 8000, clientHeight: 720, maxScrollTop: 7280 },
        scrollAfter: { scrollTop: 1236, scrollHeight: 8036, clientHeight: 720, maxScrollTop: 7316 },
      },
    })

    expect(message).toContain("composer-growth")
    expect(message).toContain("0.031")
    expect(message).toContain("primary-turn-descendant")
    expect(message).toContain('[data-component="markdown"]')
    expect(message).toContain('[data-component="session-turn"]')
    expect(message).toContain("scrollTop")
    expect(message).toContain("virtualized")
    expect(message).toContain("104")
  })
})
