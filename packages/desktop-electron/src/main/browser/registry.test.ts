import { describe, expect, test } from "bun:test"
import {
  BrowserControllerRegistry,
  draftKey,
  draftWindowID,
  rendererTarget,
  type OwnedBrowserView,
  type RegistryWindow,
} from "./registry"

// Stand-in for BrowserViewController: records the lifecycle calls the registry
// makes so the tests pin WHAT the registry decides, not how a view reacts.
class FakeView implements OwnedBrowserView {
  target: string
  hasPage = false
  destroyed = false
  hiddenFor: number[] = []
  releasedFor: number[] = []

  constructor(key: string) {
    this.target = key
  }
  retarget(target: string) {
    this.target = target
  }
  hideFor(win: RegistryWindow) {
    this.hiddenFor.push(win.id)
  }
  releaseHost(win: RegistryWindow) {
    this.releasedFor.push(win.id)
  }
  destroy() {
    this.destroyed = true
  }
  state() {
    return { hasPage: this.hasPage }
  }
}

function makeRegistry() {
  const created: FakeView[] = []
  const registry = new BrowserControllerRegistry((key: string) => {
    const view = new FakeView(key)
    created.push(view)
    return view
  })
  return { registry, created }
}

const win = (id: number): RegistryWindow => ({ id })

describe("keys", () => {
  test("draft keys are window-scoped and map back to the literal renderer target", () => {
    expect(draftKey(3)).toBe("draft:3")
    expect(draftWindowID("draft:3")).toBe(3)
    expect(draftWindowID("ses_a")).toBeNull()
    expect(rendererTarget("draft:3")).toBe("draft")
    expect(rendererTarget("ses_a")).toBe("ses_a")
  })
})

describe("BrowserControllerRegistry", () => {
  test("ensure creates one controller per key and reuses it", () => {
    const { registry, created } = makeRegistry()
    const a = registry.ensure("ses_a")
    expect(registry.ensure("ses_a")).toBe(a)
    expect(registry.get("ses_a")).toBe(a)
    expect(registry.get("ses_b")).toBeUndefined()
    expect(created.length).toBe(1)
  })

  test("adoptDraft re-keys the window's draft to the new session and reports its page", () => {
    const { registry } = makeRegistry()
    const draft = registry.ensure(draftKey(1))
    draft.hasPage = true

    const result = registry.adoptDraft(1, "ses_new")

    expect(result).toEqual({ adopted: true, hasPage: true })
    expect(draft.target).toBe("ses_new")
    expect(registry.get("ses_new")).toBe(draft)
    // The draft key is gone: the window's next Home visit starts a fresh draft.
    expect(registry.get(draftKey(1))).toBeUndefined()
  })

  test("adoptDraft refuses a target in the draft key namespace", () => {
    const { registry } = makeRegistry()
    const draft = registry.ensure(draftKey(1))
    // A renderer naming "draft:2" as the new session id must not re-key its
    // draft into window 2's private namespace.
    expect(registry.adoptDraft(1, draftKey(2))).toEqual({ adopted: false, hasPage: false })
    expect(registry.get(draftKey(1))).toBe(draft)
    expect(registry.get(draftKey(2))).toBeUndefined()
  })

  test("adoptDraft fails soft when there is no draft or the session already has a view", () => {
    const { registry } = makeRegistry()
    expect(registry.adoptDraft(1, "ses_new")).toEqual({ adopted: false, hasPage: false })

    const existing = registry.ensure("ses_new")
    const draft = registry.ensure(draftKey(1))
    expect(registry.adoptDraft(1, "ses_new")).toEqual({ adopted: false, hasPage: false })
    // Nothing moved: the session keeps its view, the draft stays a draft.
    expect(registry.get("ses_new")).toBe(existing)
    expect(registry.get(draftKey(1))).toBe(draft)
  })

  test("syncWindowDisplay hides every view the window no longer shows", () => {
    const { registry } = makeRegistry()
    const a = registry.ensure("ses_a")
    const b = registry.ensure("ses_b")
    const draft = registry.ensure(draftKey(1))

    // The window navigated to ses_a: ses_b and the draft must hide; ses_a stays.
    registry.syncWindowDisplay(win(1), "ses_a")
    expect(a.hiddenFor).toEqual([])
    expect(b.hiddenFor).toEqual([1])
    expect(draft.hiddenFor).toEqual([1])
  })

  test("syncWindowDisplay on the new-session page keeps only the window's own draft", () => {
    const { registry } = makeRegistry()
    const a = registry.ensure("ses_a")
    const ownDraft = registry.ensure(draftKey(1))
    const otherDraft = registry.ensure(draftKey(2))

    registry.syncWindowDisplay(win(1), null)
    expect(ownDraft.hiddenFor).toEqual([])
    expect(a.hiddenFor).toEqual([1])
    // Another window's draft is not this window's to keep visible — but
    // hideFor is owner-gated in the real controller, so this is a no-op there.
    expect(otherDraft.hiddenFor).toEqual([1])
  })

  test("onWindowClosing detaches conversation views but destroys the window's draft", () => {
    const { registry } = makeRegistry()
    const a = registry.ensure("ses_a")
    const draft = registry.ensure(draftKey(1))

    registry.onWindowClosing(win(1))

    // Conversation views are conversation-owned: released, alive, still registered.
    expect(a.releasedFor).toEqual([1])
    expect(a.destroyed).toBe(false)
    expect(registry.get("ses_a")).toBe(a)
    // The draft is window-owned: destroyed and gone.
    expect(draft.destroyed).toBe(true)
    expect(registry.get(draftKey(1))).toBeUndefined()
  })

  test("dispose destroys the conversation's view and forgets the key", () => {
    const { registry } = makeRegistry()
    const a = registry.ensure("ses_a")

    registry.dispose("ses_a")
    expect(a.destroyed).toBe(true)
    expect(registry.get("ses_a")).toBeUndefined()
    expect(registry.all()).toEqual([])

    // Unknown keys no-op: dispose is called unconditionally on session delete,
    // including for conversations that never opened the browser.
    registry.dispose("ses_a")
    registry.dispose("ses_unknown")
  })

  test("dispose after adoption finds the view under its adopted key", () => {
    const { registry } = makeRegistry()
    const draft = registry.ensure(draftKey(1))
    registry.adoptDraft(1, "ses_new")

    registry.dispose("ses_new")
    expect(draft.destroyed).toBe(true)
    expect(registry.all()).toEqual([])
  })
})
