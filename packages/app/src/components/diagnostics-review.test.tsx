import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as uiToast from "@opencode-ai/ui/toast"
import { runBrowserCheck } from "@/testing/browser-subprocess"
import type { PrepareReportResult } from "@/desktop-api-contract"

const toastCalls: any[] = []
let openDiagnosticsReview: typeof import("./diagnostics-review").openDiagnosticsReview
const originalReact = (globalThis as any).React

beforeAll(async () => {
  // spyOn (not mock.module) so mock.restore fully reverts it — a module mock for
  // showToast would leak into every other suite's toast assertions.
  spyOn(uiToast, "showToast").mockImplementation((options) => {
    toastCalls.push(options)
    return 0
  })
  openDiagnosticsReview = (await import("./diagnostics-review")).openDiagnosticsReview
})

beforeEach(() => {
  toastCalls.length = 0
  // Bun compiles the imported TSX through React.createElement; the review dialog
  // factory is only invoked by dialog.show, which is mocked here.
  ;(globalThis as any).React = {
    createElement: (component: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
      if (typeof component === "function") return component({ ...(props ?? {}), children })
      return null
    },
  }
})

afterAll(() => {
  mock.restore()
  if (originalReact === undefined) delete (globalThis as any).React
  else (globalThis as any).React = originalReact
})

type ReviewDeps = Parameters<typeof openDiagnosticsReview>[0]
const language = { t: (key: string) => key } as unknown as ReviewDeps["language"]

function makeDialog() {
  const shown: unknown[] = []
  return {
    shown,
    control: {
      show: (element: unknown) => {
        shown.push(element)
      },
      close: () => undefined,
    },
  }
}

const ready: Extract<PrepareReportResult, { status: "ready" }> = {
  status: "ready",
  reportId: "rid_1",
  fileName: "pawwork-problem-report.md",
  locationHint: "PawWork app data/.../pawwork-problem-report.md",
  hasForm: true,
  contents: { logLines: 2, sessionMessages: null, rendererEvents: 0, rendererError: false },
}

const failed: Extract<PrepareReportResult, { status: "failed" }> = {
  status: "failed",
  reason: "permission_denied",
  summary: "PawWork Problem Report Summary\nFull report: not generated",
}

// The desktop bridge wires reveal/submit alongside prepare; openDiagnosticsReview
// resolves all three before opening, so the mocks provide the full set.
const bridge = {
  revealReport: async () => ({ status: "revealed" }) as const,
  submitReport: async () => ({ status: "opened" }) as const,
}

describe("openDiagnosticsReview", () => {
  test("does nothing when the platform cannot prepare reports", async () => {
    const dialog = makeDialog()
    await openDiagnosticsReview({ platform: {}, dialog: dialog.control, language })
    expect(dialog.shown).toHaveLength(0)
    expect(toastCalls).toHaveLength(0)
  })

  test("does nothing when the reveal/submit actions are missing", async () => {
    const dialog = makeDialog()
    // A half-wired bridge (prepare without reveal/submit) must not open a review the
    // body cannot drive — validate the full action set at the boundary.
    await openDiagnosticsReview({
      platform: { prepareReport: async () => ready },
      dialog: dialog.control,
      language,
    })
    expect(dialog.shown).toHaveLength(0)
    expect(toastCalls).toHaveLength(0)
  })

  test("opens the review dialog when a package is ready", async () => {
    const dialog = makeDialog()
    await openDiagnosticsReview({
      platform: { prepareReport: async () => ready, ...bridge },
      dialog: dialog.control,
      language,
    })
    expect(dialog.shown).toHaveLength(1)
    expect(toastCalls).toHaveLength(0)
  })

  test("surfaces an error toast instead of a dialog when preparation fails", async () => {
    const dialog = makeDialog()
    await openDiagnosticsReview({
      platform: { prepareReport: async () => failed, ...bridge },
      dialog: dialog.control,
      language,
    })
    expect(dialog.shown).toHaveLength(0)
    expect(toastCalls).toHaveLength(1)
    expect(toastCalls[0]).toMatchObject({ variant: "error", title: "diagnostics.review.prepareFailed" })
  })

  test("treats a rejected preparation as a failure toast", async () => {
    const dialog = makeDialog()
    await openDiagnosticsReview({
      platform: {
        prepareReport: async () => {
          throw new Error("ipc unavailable")
        },
        ...bridge,
      },
      dialog: dialog.control,
      language,
    })
    expect(dialog.shown).toHaveLength(0)
    expect(toastCalls).toHaveLength(1)
    expect(toastCalls[0]).toMatchObject({ variant: "error" })
  })
})

// DiagnosticsReviewBody drives reveal/submit against the platform bridge. The render
// shim here is non-reactive (JSX compiles through React.createElement, like the other
// browser-subprocess checks), so we assert the observable handler contract: which
// terminal states close the surface (onDone) versus keep it open, and that an IPC
// rejection from reveal or submit is caught rather than leaked as an unhandled rejection.
const reviewBodyCheck = String.raw`
import { mock } from "bun:test"
import { createRoot } from "solid-js"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

let unhandled = 0
process.on("unhandledRejection", () => { unhandled++ })

const buttons = []
globalThis.React = {
  createElement(type, props, ...children) {
    const kids = children.length <= 1 ? children[0] : children
    if (typeof type === "function") return type({ ...(props ?? {}), children: kids })
    return kids
  },
}

mock.module("@opencode-ai/ui/button", () => ({
  Button: (props) => { buttons.push(props); return props.children },
}))
mock.module("@opencode-ai/ui/dialog", () => ({ Dialog: (props) => props.children }))
mock.module("@opencode-ai/ui/toast", () => ({ showToast: () => 0 }))

const { DiagnosticsReviewBody } = await import("./src/components/diagnostics-review.tsx")

const language = { t: (key) => key }
const ready = {
  status: "ready",
  reportId: "rid_1",
  fileName: "pawwork-problem-report.md",
  locationHint: "…/pawwork-problem-report.md",
  hasForm: true,
  contents: { logLines: 2, sessionMessages: null, rendererEvents: 0, rendererError: false },
}

const textOf = (node) => {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(textOf).join("")
  return ""
}
const clickByText = async (needle) => {
  const button = buttons.find((b) => textOf(b.children).includes(needle))
  assert(button, "no button matching " + needle + " among " + buttons.length)
  await button.onClick()
}

// Non-optional ReviewActions: the body never guards a missing method, so both are always present.
const acts = (overrides) => ({
  revealReport: async () => ({ status: "revealed" }),
  submitReport: async () => ({ status: "opened" }),
  ...overrides,
})

const mount = (actions, onDone) => {
  buttons.length = 0
  return createRoot((dispose) => {
    DiagnosticsReviewBody({ result: ready, actions, language, onDone })
    return dispose
  })
}

const submit = "diagnostics.review.action.submit"
const reveal = "diagnostics.review.action.reveal"

// A successful submit (form opened) is the only terminal state that closes the surface.
{
  let done = 0
  const dispose = mount(acts({ submitReport: async () => ({ status: "opened" }) }), () => { done++ })
  await clickByText(submit)
  assert(done === 1, "opened submit must call onDone once, got " + done)
  dispose()
}

// A newer prepare replaced this package: keep the surface open instead of silently closing.
{
  let done = 0
  const dispose = mount(acts({ submitReport: async () => ({ status: "stale" }) }), () => { done++ })
  await clickByText(submit)
  assert(done === 0, "stale submit must keep the surface open (no onDone), got " + done)
  dispose()
}

// Form fallback shows the manual link, so the surface stays open for the user to copy it.
{
  let done = 0
  const dispose = mount(
    acts({ submitReport: async () => ({ status: "form-fallback", feedbackUrl: "https://x", summary: "s" }) }),
    () => { done++ },
  )
  await clickByText(submit)
  assert(done === 0, "form-fallback submit must keep the surface open (no onDone), got " + done)
  dispose()
}

// An IPC rejection on submit must be caught (recoverable notice) and not close the surface.
{
  let done = 0
  const dispose = mount(acts({ submitReport: async () => { throw new Error("ipc boom") } }), () => { done++ })
  await clickByText(submit)
  await new Promise((r) => setTimeout(r, 10))
  assert(done === 0, "rejected submit must not close the surface, got " + done)
  assert(unhandled === 0, "rejected submit must be caught, got " + unhandled)
  dispose()
}

// Reveal forwards the reportId and never closes the surface on success.
{
  let done = 0
  let revealedWith
  const dispose = mount(
    acts({ revealReport: async (id) => { revealedWith = id; return { status: "revealed" } } }),
    () => { done++ },
  )
  await clickByText(reveal)
  await new Promise((r) => setTimeout(r, 10))
  assert(revealedWith === "rid_1", "reveal must forward the reportId, got " + revealedWith)
  assert(done === 0, "a successful reveal must keep the surface open, got " + done)
  dispose()
}

// A stale or failed reveal result keeps the surface open (the notice area shows it).
for (const status of ["stale", "failed"]) {
  let done = 0
  const dispose = mount(acts({ revealReport: async () => ({ status }) }), () => { done++ })
  await clickByText(reveal)
  await new Promise((r) => setTimeout(r, 10))
  assert(done === 0, status + " reveal must keep the surface open (no onDone), got " + done)
  dispose()
}

// An IPC rejection on reveal is caught rather than leaked, surface stays open.
{
  let done = 0
  const dispose = mount(acts({ revealReport: async () => { throw new Error("open boom") } }), () => { done++ })
  await clickByText(reveal)
  await new Promise((r) => setTimeout(r, 10))
  assert(done === 0, "rejected reveal must not close the surface, got " + done)
  assert(unhandled === 0, "a rejected reveal must be caught, got " + unhandled)
  dispose()
}

// Sequence: a stale reveal then a rejected submit. The single notice signal means submit
// clears the prior stale notice before setting its own — so only the latest reason can show,
// never a mixed stale+failed pair. The surface stays open and neither failure leaks.
{
  let done = 0
  const dispose = mount(
    acts({ revealReport: async () => ({ status: "stale" }), submitReport: async () => { throw new Error("ipc boom") } }),
    () => { done++ },
  )
  await clickByText(reveal)
  await clickByText(submit)
  await new Promise((r) => setTimeout(r, 10))
  assert(done === 0, "stale-then-failed sequence must keep the surface open, got " + done)
  assert(unhandled === 0, "sequence failures must be caught, got " + unhandled)
  dispose()
}
`

describe("DiagnosticsReviewBody", () => {
  test("closes only on a successful submit and never leaks reveal/submit rejections", () => {
    runBrowserCheck(reviewBodyCheck)
  })
})
