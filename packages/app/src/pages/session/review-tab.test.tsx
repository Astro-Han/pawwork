import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"

let SessionReviewTab: typeof import("./review-tab").SessionReviewTab
const capturedProps: any[] = []

beforeAll(async () => {
  mock.module("@opencode-ai/ui/session-review", () => ({
    SessionReview: (props: any) => {
      capturedProps.push(props)
      return null
    },
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => ({
      client: {
        file: {
          read: async () => ({ data: "" }),
        },
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      ready: () => true,
    }),
  }))

  SessionReviewTab = (await import("./review-tab")).SessionReviewTab
})

beforeEach(() => {
  capturedProps.length = 0
  document.body.innerHTML = ""
  ;(globalThis as any).React = {
    createElement: (component: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
      if (typeof component === "function") return component({ ...(props ?? {}), children })
      return null
    },
  }
})

afterAll(() => {
  mock.restore()
})

describe("SessionReviewTab", () => {
  test("keeps PawWork review diffs in unified mode without exposing style switching", () => {
    const root = document.createElement("div")
    document.body.append(root)

    const dispose = createRoot((dispose) => {
      SessionReviewTab({
        diffs: () => [
          {
            file: "src/demo.ts",
            patch: "@@ -1 +1 @@\n-old\n+new\n",
            additions: 1,
            deletions: 1,
            status: "modified",
          },
        ],
        view: () =>
          ({
            review: {
              open: () => [],
              setOpen: () => undefined,
            },
            scroll: () => undefined,
            setScroll: () => undefined,
          }) as any,
      })
      return dispose
    })

    expect(capturedProps).toHaveLength(1)
    expect(capturedProps[0].diffStyle).toBe("unified")
    expect(capturedProps[0].onDiffStyleChange).toBeUndefined()

    dispose()
  })
})
