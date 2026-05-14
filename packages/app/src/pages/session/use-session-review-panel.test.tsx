import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionReviewPanel } from "./use-session-review-panel"

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createSessionReviewPanel", () => {
  test("does not open the Files panel when a turn adds a file", async () => {
    const calls: string[] = []
    let dispose: (() => void) | undefined

    createRoot((cleanup) => {
      dispose = cleanup
      const [turnDiffs, setTurnDiffs] = createSignal<Array<{ status?: string | null }>>([])

      createSessionReviewPanel({
        activeFileTab: () => undefined,
        canReview: () => false,
        comments: {
          all: () => [],
          focus: () => undefined,
          setFocus: () => undefined,
        } as any,
        commentContext: {
          add: () => undefined,
          remove: () => undefined,
          update: () => undefined,
        } as any,
        deferRender: () => true,
        file: {
          load: () => Promise.resolve(),
          pathFromTab: () => undefined,
          searchFilesAndDirectories: () => [],
          tab: (path: string) => `file://${path}`,
          tree: {
            list: () => Promise.resolve(),
            refresh: () => Promise.resolve(),
          },
        } as any,
        isDesktop: () => true,
        language: { t: (key: string) => key } as any,
        reviewState: {
          artifactFiles: () => [],
          changes: () => "turn",
          changesOptions: () => ["turn"],
          hasReview: () => false,
          loadVcs: () => Promise.resolve(),
          reviewCount: () => 0,
          reviewDiffs: () => [],
          reviewReady: () => true,
          setChanges: () => undefined,
          vcsMode: () => undefined,
        } as any,
        routeSessionID: () => "ses_1",
        sdk: { directory: "/repo" } as any,
        sessionKey: () => "server:/repo:ses_1",
        sync: {
          data: {
            session_diff: {},
            session_status: {},
          },
          project: { vcs: "git" },
          session: {
            diff: () => Promise.resolve(),
          },
          status: "ready",
        } as any,
        timelineDiffs: () => [],
        turnDiffs,
        view: () =>
          ({
            setScroll: () => undefined,
            sidePanel: {
              explorer: {
                setTab: () => undefined,
                tab: () => "changes",
              },
              open: () => calls.push("open"),
              opened: () => false,
              setTab: (tab: string) => calls.push(`setTab:${tab}`),
              tab: () => "status",
            },
          }) as any,
        wantsReview: () => false,
        openTab: () => undefined,
        setActiveTab: () => undefined,
      } as any)

      setTurnDiffs([{ status: "added" }])
    })

    await nextTick()
    dispose?.()

    expect(calls).not.toContain("setTab:files")
    expect(calls).not.toContain("open")
  })
})
