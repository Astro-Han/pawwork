import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as uiToast from "@opencode-ai/ui/toast"
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

describe("openDiagnosticsReview", () => {
  test("does nothing when the platform cannot prepare reports", async () => {
    const dialog = makeDialog()
    await openDiagnosticsReview({ platform: {}, dialog: dialog.control, language })
    expect(dialog.shown).toHaveLength(0)
    expect(toastCalls).toHaveLength(0)
  })

  test("opens the review dialog when a package is ready", async () => {
    const dialog = makeDialog()
    await openDiagnosticsReview({
      platform: { prepareReport: async () => ready },
      dialog: dialog.control,
      language,
    })
    expect(dialog.shown).toHaveLength(1)
    expect(toastCalls).toHaveLength(0)
  })

  test("surfaces an error toast instead of a dialog when preparation fails", async () => {
    const dialog = makeDialog()
    await openDiagnosticsReview({
      platform: { prepareReport: async () => failed },
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
      },
      dialog: dialog.control,
      language,
    })
    expect(dialog.shown).toHaveLength(0)
    expect(toastCalls).toHaveLength(1)
    expect(toastCalls[0]).toMatchObject({ variant: "error" })
  })
})
