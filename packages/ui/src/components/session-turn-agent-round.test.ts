import { expect, test, describe } from "bun:test"
import { readFileSync } from "node:fs"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import {
  computeElapsedSec,
  isInterrupted,
  selectFirstAssistant,
  selectLatestAssistant,
} from "./session-turn-agent-round"

const source = readFileSync(new URL("./session-turn-agent-round.tsx", import.meta.url), "utf8")
const css = readFileSync(new URL("./session-turn-agent-round.css", import.meta.url), "utf8")

function makeMessage(input: {
  id: string
  created?: number
  completed?: number
  errorName?: string
}): AssistantMessage {
  // Construct a minimal AssistantMessage shape — the helpers under test
  // only read `id`, `time.created` / `time.completed`, and `error.name`.
  // Other SDK fields are filled with stubs so the structural literal
  // type-checks under the SDK union.
  return {
    id: input.id,
    sessionID: "s",
    role: "assistant",
    parentID: "p",
    agent: "default",
    summary: undefined,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "model-x",
    providerID: "test",
    mode: "build",
    path: { cwd: "/", root: "/" },
    system: [],
    time: {
      created: input.created ?? 0,
      ...(typeof input.completed === "number" ? { completed: input.completed } : {}),
    },
    ...(input.errorName
      ? {
          error: {
            name: input.errorName,
            data: {},
          },
        }
      : {}),
  } as unknown as AssistantMessage
}

describe("selectFirstAssistant", () => {
  test("empty list returns undefined", () => {
    expect(selectFirstAssistant([])).toBeUndefined()
  })

  test("picks the assistant with the smallest time.created", () => {
    const m1 = makeMessage({ id: "a", created: 200 })
    const m2 = makeMessage({ id: "b", created: 100 })
    const m3 = makeMessage({ id: "c", created: 300 })
    expect(selectFirstAssistant([m1, m2, m3])?.id).toBe("b")
  })

  test("ignores assistants without a time.created (still-pending stream)", () => {
    const m1 = makeMessage({ id: "no-time", created: NaN })
    // Clear the created to undefined to force the skip path.
    delete (m1 as { time?: { created?: number } }).time
    const m2 = makeMessage({ id: "b", created: 100 })
    expect(selectFirstAssistant([m1, m2])?.id).toBe("b")
  })
})

describe("selectLatestAssistant", () => {
  test("prefers a still-running assistant over any completed one (round is live)", () => {
    const completed = makeMessage({ id: "done", created: 100, completed: 200 })
    const running = makeMessage({ id: "running", created: 300 })
    expect(selectLatestAssistant([completed, running])?.id).toBe("running")
  })

  test("when all parts are completed, picks the largest time.completed", () => {
    const a = makeMessage({ id: "a", created: 100, completed: 200 })
    const b = makeMessage({ id: "b", created: 150, completed: 300 })
    const c = makeMessage({ id: "c", created: 200, completed: 250 })
    expect(selectLatestAssistant([a, b, c])?.id).toBe("b")
  })

  test("empty list returns undefined", () => {
    expect(selectLatestAssistant([])).toBeUndefined()
  })
})

describe("isInterrupted", () => {
  test("true when the latest assistant carries a MessageAbortedError", () => {
    const a = makeMessage({ id: "a", created: 100, completed: 200 })
    const b = makeMessage({ id: "b", created: 200, errorName: "MessageAbortedError" })
    expect(isInterrupted([a, b])).toBe(true)
  })

  test("false when the latest assistant has no error", () => {
    const a = makeMessage({ id: "a", created: 100, completed: 200 })
    expect(isInterrupted([a])).toBe(false)
  })

  test("false when an older message had an abort but the latest finished cleanly", () => {
    const old = makeMessage({ id: "old", created: 100, completed: 200, errorName: "MessageAbortedError" })
    const fresh = makeMessage({ id: "fresh", created: 300, completed: 400 })
    expect(isInterrupted([old, fresh])).toBe(false)
  })

  test("false when the latest assistant carries a non-abort error (other error kinds are not system events)", () => {
    const bad = makeMessage({ id: "bad", created: 100, completed: 200, errorName: "ProviderError" })
    expect(isInterrupted([bad])).toBe(false)
  })
})

describe("computeElapsedSec", () => {
  test("returns 0 when startMs is undefined (no firstAssistant yet)", () => {
    expect(computeElapsedSec({ startMs: undefined, endMs: undefined, nowMs: 9999 })).toBe(0)
  })

  test("returns floor((endMs - startMs) / 1000) when the round has completed", () => {
    expect(computeElapsedSec({ startMs: 1000, endMs: 5500, nowMs: 9999 })).toBe(4)
  })

  test("uses nowMs while running (endMs undefined)", () => {
    expect(computeElapsedSec({ startMs: 1000, endMs: undefined, nowMs: 6200 })).toBe(5)
  })

  test("clamps to 0 when endMs < startMs (clock skew defensive)", () => {
    expect(computeElapsedSec({ startMs: 5000, endMs: 1000, nowMs: 9999 })).toBe(0)
  })
})

// ============================================================================
// Source-grep invariants — race / cleanup / suppression posture
// ============================================================================

test("1Hz tick is cleaned up on unmount AND on isRunning flip (§3.2)", () => {
  expect(source).toMatch(/onCleanup\(\(\) => \{[\s\S]*clearInterval\(id\)[\s\S]*removeEventListener\("visibilitychange"/)
})

test("visibilitychange listener refreshes `now` immediately on tab focus return (§3.2)", () => {
  expect(source).toMatch(/const onVisibility = \(\) => \{[\s\S]*if \(!document\.hidden\) setNow\(Date\.now\(\)\)/)
})

test("Fork action has in-flight disabled guard (§6.14 rapid-click)", () => {
  expect(source).toMatch(/const \[forking, setForking\] = createSignal\(false\)/)
  expect(source).toMatch(/if \(forking\(\) \|\| !props\.actions\?\.onFork\) return/)
  expect(source).toMatch(/disabled=\{forking\(\)\}/)
})

test("Fork handler uses try/finally so setForking(false) always runs — survives unmount race (§6.14)", () => {
  expect(source).toMatch(/setForking\(true\)\s+try \{[\s\S]*await props\.actions\.onFork\(\)[\s\S]*\} finally \{[\s\S]*setForking\(false\)/)
})

test("running suppression is FULL — not opacity-only — keyboard cannot Tab into mid-stream toolbar (§3.6)", () => {
  // The wrap carries data-running while running; the toolbar CSS uses
  // visibility:hidden + pointer-events:none + opacity:0 (three layers).
  expect(source).toMatch(/data-running=\{isRunning\(\) \|\| undefined\}/)
  expect(source).toMatch(/aria-hidden=\{isRunning\(\) \|\| undefined\}/)
  expect(css).toMatch(
    /\[data-running\]\s+\[data-slot="agent-toolbar"\][^{}]*\{[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none[^}]*opacity:\s*0/,
  )
})

test("agent prose / reasoning / trow-block routed through groupParts (single source of truth)", () => {
  expect(source).toMatch(/from "\.\/message-part-group"/)
  expect(source).toMatch(/<TrowBlock\b/)
  expect(source).toMatch(/<SystemEvent kind="interrupted"/)
})

test("renderProse is a caller-injected slot — the round does not import the markdown renderer (§2)", () => {
  expect(source).toMatch(/renderProse:\s*\(input:\s*\{[\s\S]*?\}\)\s*=>\s*JSX\.Element/)
  // Must not pull in any concrete markdown renderer.
  expect(source).not.toMatch(/^import [^\n]*Markdown[^\n]*from/m)
})

test("working-time header is always visible (not hover-gated) — Codex Desktop派 (DESIGN.md L466)", () => {
  // The header sits outside the .agent-toolbar opacity-driven block.
  expect(source).toMatch(/data-slot="agent-working-time">\{props\.labels\.workingTime\(elapsedSec\(\)\)\}/)
  expect(css).not.toMatch(/\[data-slot="agent-working-time"\][^{}]*\{[^}]*opacity:\s*0/)
})
