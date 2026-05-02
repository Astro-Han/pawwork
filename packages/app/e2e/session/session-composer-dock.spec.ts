import { mkdir } from "node:fs/promises"
import { test, expect } from "../fixtures"
import {
  composerEvent,
  type ComposerDriverState,
  type ComposerProbeState,
  type ComposerStateProbeState,
  type ComposerWindow,
} from "../../src/testing/session-composer"
import { cleanupSession, clearSessionDockSeed, closeSettingsPanel, openSettings, seedSessionQuestion } from "../actions"
import {
  permissionDockSelector,
  promptSelector,
  questionDockSelector,
  sessionComposerDockSelector,
  sessionTodoToggleButtonSelector,
} from "../selectors"
import { modKey } from "../utils"
import { inputMatch } from "../prompt/mock"
import { dict as enDict } from "../../src/i18n/en"

type Sdk = Parameters<typeof clearSessionDockSeed>[0]
type PermissionRule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }

async function withDockSession<T>(
  sdk: Sdk,
  title: string,
  fn: (session: { id: string; title: string }) => Promise<T>,
  opts?: { permission?: PermissionRule[]; trackSession?: (sessionID: string) => void },
) {
  const session = await sdk.session
    .create(opts?.permission ? { title, permission: opts.permission } : { title })
    .then((r) => r.data)
  if (!session?.id) throw new Error("Session create did not return an id")
  opts?.trackSession?.(session.id)
  try {
    return await fn(session)
  } finally {
    await cleanupSession({ sdk, sessionID: session.id })
  }
}

const defaultQuestions = [
  {
    header: "Need input",
    question: "Pick one option",
    options: [
      { label: "Continue", description: "Continue now" },
      { label: "Stop", description: "Stop here" },
    ],
  },
]

const multiQuestions = [
  {
    header: "Q1",
    question: "Pick first option",
    options: [
      { label: "First A", description: "Answer first" },
      { label: "First B", description: "Alternate first" },
    ],
  },
  {
    header: "Q2",
    question: "Pick second option",
    options: [
      { label: "Second A", description: "Answer second" },
      { label: "Second B", description: "Alternate second" },
    ],
  },
]

test.setTimeout(120_000)

async function withDockSeed<T>(sdk: Sdk, sessionID: string, fn: () => Promise<T>) {
  try {
    return await fn()
  } finally {
    await clearSessionDockSeed(sdk, sessionID).catch(() => undefined)
  }
}

async function clearPermissionDock(page: any, label: RegExp) {
  const dock = page.locator(permissionDockSelector)
  await expect(dock).toBeVisible()
  await dock.getByRole("button", { name: label }).click()
}

async function setAutoAccept(page: any, enabled: boolean) {
  const dialog = await openSettings(page)
  const toggle = dialog.locator('[data-action="settings-auto-accept-permissions"]').first()
  const input = toggle.locator('[data-slot="switch-input"]').first()
  await expect(toggle).toBeVisible()
  const checked = (await input.getAttribute("aria-checked")) === "true"
  if (checked !== enabled) await toggle.locator('[data-slot="switch-control"]').click()
  await expect(input).toHaveAttribute("aria-checked", enabled ? "true" : "false")
  await closeSettingsPanel(page, dialog)
}

async function expectQuestionBlocked(page: any) {
  await expect(page.locator(questionDockSelector)).toBeVisible()
  await expect(page.locator(promptSelector)).toHaveCount(0)
}

async function expectQuestionOpen(page: any) {
  await expect(page.locator(questionDockSelector)).toHaveCount(0)
  await expect(page.locator(promptSelector)).toBeVisible()
}

async function expectPermissionBlocked(page: any) {
  await expect(page.locator(permissionDockSelector)).toBeVisible()
  await expect(page.locator(promptSelector)).toHaveCount(0)
}

async function expectPermissionOpen(page: any) {
  await expect(page.locator(permissionDockSelector)).toHaveCount(0)
  await expect(page.locator(promptSelector)).toBeVisible()
}

async function todoDock(page: any, sessionID: string) {
  await page.addInitScript(() => {
    const win = window as ComposerWindow
    const saved = window.sessionStorage.getItem("__opencode_e2e_composer_sessions")
    const sessions = saved ? JSON.parse(saved) : {}
    win.__opencode_e2e = {
      ...win.__opencode_e2e,
      composer: {
        enabled: true,
        sessions,
      },
    }
  })

  const write = async (driver: ComposerDriverState | undefined) => {
    await page.evaluate(
      (input: { event: string; sessionID: string; driver: ComposerDriverState | undefined }) => {
        const win = window as ComposerWindow
        const composer = win.__opencode_e2e?.composer
        if (!composer?.enabled) throw new Error("Composer e2e driver is not enabled")
        composer.sessions ??= {}
        const prev = composer.sessions[input.sessionID] ?? {}
        const stateProbe = prev.stateProbe
        const stateProbeHasValue =
          stateProbe &&
          (stateProbe.dock ||
            stateProbe.opening ||
            stateProbe.completing ||
            stateProbe.count > 0 ||
            stateProbe.states.length > 0)
        const nextStateProbe = stateProbeHasValue ? stateProbe : undefined
        if (!input.driver) {
          if (!prev.probe && !nextStateProbe) {
            delete composer.sessions[input.sessionID]
          } else {
            composer.sessions[input.sessionID] = { probe: prev.probe, stateProbe: nextStateProbe }
          }
        } else {
          composer.sessions[input.sessionID] = {
            ...prev,
            stateProbe: nextStateProbe,
            driver: input.driver,
          }
        }
        window.sessionStorage.setItem("__opencode_e2e_composer_sessions", JSON.stringify(composer.sessions))
        window.dispatchEvent(new CustomEvent(input.event, { detail: { sessionID: input.sessionID } }))
      },
      { event: composerEvent, sessionID, driver },
    )
  }

  const readUi = () =>
    page.evaluate((sessionID: string) => {
      const win = window as ComposerWindow
      return win.__opencode_e2e?.composer?.sessions?.[sessionID]?.probe ?? null
    }, sessionID) as Promise<ComposerProbeState | null>

  const readState = () =>
    page.evaluate((sessionID: string) => {
      const win = window as ComposerWindow
      return win.__opencode_e2e?.composer?.sessions?.[sessionID]?.stateProbe ?? null
    }, sessionID) as Promise<ComposerStateProbeState | null>

  const api = {
    async expectUi(expected: Partial<ComposerProbeState>, timeout = 10_000) {
      await expect.poll(readUi, { timeout }).toMatchObject(expected)
      return api
    },
    async expectState(expected: Partial<ComposerStateProbeState>, timeout = 10_000) {
      await expect.poll(readState, { timeout }).toMatchObject(expected)
      return api
    },
    async expectUnmounted(timeout = 10_000) {
      await expect.poll(readUi, { timeout }).toMatchObject({
        mounted: false,
        hidden: true,
        count: 0,
        states: [],
      })
      return api
    },
    async expectDockGone(timeout = 10_000) {
      await expect(page.locator('[data-component="session-todo-dock"]')).toHaveCount(0, { timeout })
      return api
    },
    async clear() {
      await write(undefined)
      return api
    },
    async open(todos: NonNullable<ComposerDriverState["todos"]>) {
      await write({ todos })
      return api
    },
    async finish(todos: NonNullable<ComposerDriverState["todos"]>) {
      await write({ todos })
      return api
    },
    async expectOpen(states: ComposerProbeState["states"]) {
      await expect.poll(readUi, { timeout: 10_000 }).toMatchObject({
        mounted: true,
        collapsed: false,
        hidden: false,
        count: states.length,
        states,
      })
      return api
    },
    async expectCollapsed(states: ComposerProbeState["states"]) {
      await expect.poll(readUi, { timeout: 10_000 }).toMatchObject({
        mounted: true,
        collapsed: true,
        hidden: true,
        count: states.length,
        states,
      })
      return api
    },
    async collapse() {
      await page.locator(sessionTodoToggleButtonSelector).click()
      return api
    },
    async expand() {
      await page.locator(sessionTodoToggleButtonSelector).click()
      return api
    },
  }

  return api
}

async function withMockPermission<T>(
  page: any,
  request: {
    id: string
    sessionID: string
    permission: string
    patterns: string[]
    metadata?: Record<string, unknown>
    always?: string[]
  },
  opts: { child?: any } | undefined,
  fn: (state: { resolved: () => Promise<void> }) => Promise<T>,
) {
  const listUrl = /\/permission(?:\?.*)?$/
  const replyUrls = [/\/session\/[^/]+\/permissions\/[^/?]+(?:\?.*)?$/, /\/permission\/[^/]+\/reply(?:\?.*)?$/]
  let pending = [
    {
      ...request,
      always: request.always ?? ["*"],
      metadata: request.metadata ?? {},
    },
  ]

  const list = async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(pending),
    })
  }

  const reply = async (route: any) => {
    const url = new URL(route.request().url())
    const parts = url.pathname.split("/").filter(Boolean)
    const id = parts.at(-1) === "reply" ? parts.at(-2) : parts.at(-1)
    pending = pending.filter((item) => item.id !== id)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(true),
    })
  }

  await page.route(listUrl, list)
  for (const item of replyUrls) {
    await page.route(item, reply)
  }

  const sessionList = opts?.child
    ? async (route: any) => {
        const res = await route.fetch()
        const json = await res.json()
        const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : undefined
        if (Array.isArray(list) && !list.some((item) => item?.id === opts.child?.id)) list.push(opts.child)
        await route.fulfill({
          response: res,
          body: JSON.stringify(json),
        })
      }
    : undefined

  if (sessionList) await page.route("**/session?*", sessionList)

  const state = {
    async resolved() {
      await expect.poll(() => pending.length, { timeout: 10_000 }).toBe(0)
    },
  }

  try {
    return await fn(state)
  } finally {
    await page.unroute(listUrl, list)
    for (const item of replyUrls) {
      await page.unroute(item, reply)
    }
    if (sessionList) await page.unroute("**/session?*", sessionList)
  }
}

test("default dock shows prompt input", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock default",
    async (session) => {
      await project.gotoSession(session.id)

      await expect(page.locator(sessionComposerDockSelector)).toBeVisible()
      await expect(page.locator(promptSelector)).toBeVisible()
      await expect(page.locator('[data-action="prompt-permissions"]')).toHaveCount(0)
      await expect(page.locator(questionDockSelector)).toHaveCount(0)
      await expect(page.locator(permissionDockSelector)).toHaveCount(0)

      await page.locator(promptSelector).click()
      await expect(page.locator(promptSelector)).toBeFocused()
    },
    { trackSession: project.trackSession },
  )
})

test("auto-accept toggle works before first submit", async ({ page, project }) => {
  await project.open()

  await setAutoAccept(page, true)
  await setAutoAccept(page, false)
})

test("blocked question flow unblocks after submit", async ({ page, llm, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock question",
    async (session) => {
      await withDockSeed(project.sdk, session.id, async () => {
        await project.gotoSession(session.id)

        await llm.toolMatch(inputMatch({ questions: defaultQuestions }), "question", { questions: defaultQuestions })
        await seedSessionQuestion(project.sdk, {
          sessionID: session.id,
          questions: defaultQuestions,
        })

        const dock = page.locator(questionDockSelector)
        await expectQuestionBlocked(page)

        await dock.locator('[data-slot="question-option"]').first().click()
        await dock.getByRole("button", { name: /submit/i }).click()

        await expectQuestionOpen(page)
      })
    },
    { trackSession: project.trackSession },
  )
})

test("blocked question flow supports skipping one question before submit", async ({ page, llm, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock question skip",
    async (session) => {
      await withDockSeed(project.sdk, session.id, async () => {
        await project.gotoSession(session.id)

        await llm.toolMatch(inputMatch({ questions: multiQuestions }), "question", { questions: multiQuestions })
        await seedSessionQuestion(project.sdk, {
          sessionID: session.id,
          questions: multiQuestions,
        })

        const dock = page.locator(questionDockSelector)
        await expectQuestionBlocked(page)

        await dock.getByRole("button", { name: /skip question/i }).click()
        await expect(dock.locator('[data-slot="question-header-seq"]')).toContainText("2 of 2")
        await dock.locator('[data-slot="question-option"]').first().click()
        await dock.getByRole("button", { name: /submit/i }).click()

        await expectQuestionOpen(page)
      })
    },
    { trackSession: project.trackSession },
  )
})

test("blocked question flow supports submitting after skipping every question", async ({ page, llm, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock question skip all",
    async (session) => {
      await withDockSeed(project.sdk, session.id, async () => {
        await project.gotoSession(session.id)

        await llm.toolMatch(inputMatch({ questions: multiQuestions }), "question", { questions: multiQuestions })
        await seedSessionQuestion(project.sdk, {
          sessionID: session.id,
          questions: multiQuestions,
        })

        const dock = page.locator(questionDockSelector)
        await expectQuestionBlocked(page)

        await dock.getByRole("button", { name: /skip question/i }).click()
        await expect(dock.locator('[data-slot="question-header-seq"]')).toContainText("2 of 2")
        await dock.getByRole("button", { name: /skip question/i }).click()
        await dock.getByRole("button", { name: /submit/i }).click()

        await expectQuestionOpen(page)
      })
    },
    { trackSession: project.trackSession },
  )
})

test("blocked question flow supports keyboard shortcuts", async ({ page, llm, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock question keyboard",
    async (session) => {
      await withDockSeed(project.sdk, session.id, async () => {
        await project.gotoSession(session.id)

        await llm.toolMatch(inputMatch({ questions: defaultQuestions }), "question", { questions: defaultQuestions })
        await seedSessionQuestion(project.sdk, {
          sessionID: session.id,
          questions: defaultQuestions,
        })

        const dock = page.locator(questionDockSelector)
        const first = dock.locator('[data-slot="question-option"]').first()
        const second = dock.locator('[data-slot="question-option"]').nth(1)

        await expectQuestionBlocked(page)
        await expect(first).toBeFocused()

        await page.keyboard.press("ArrowDown")
        await expect(second).toBeFocused()

        await page.keyboard.press("Space")
        await page.keyboard.press(`${modKey}+Enter`)
        await expectQuestionOpen(page)
      })
    },
    { trackSession: project.trackSession },
  )
})

test("blocked question flow supports escape dismiss", async ({ page, llm, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock question escape",
    async (session) => {
      await withDockSeed(project.sdk, session.id, async () => {
        await project.gotoSession(session.id)

        await llm.toolMatch(inputMatch({ questions: defaultQuestions }), "question", { questions: defaultQuestions })
        await seedSessionQuestion(project.sdk, {
          sessionID: session.id,
          questions: defaultQuestions,
        })

        const dock = page.locator(questionDockSelector)
        const first = dock.locator('[data-slot="question-option"]').first()

        await expectQuestionBlocked(page)
        await expect(first).toBeFocused()

        await page.keyboard.press("Escape")
        await expectQuestionOpen(page)
      })
    },
    { trackSession: project.trackSession },
  )
})

test("blocked permission flow supports allow once", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock permission once",
    async (session) => {
      await project.gotoSession(session.id)
      await setAutoAccept(page, false)
      await withMockPermission(
        page,
        {
          id: "per_e2e_once",
          sessionID: session.id,
          permission: "bash",
          patterns: ["/tmp/opencode-e2e-perm-once"],
          metadata: { description: "Need permission for command" },
        },
        undefined,
        async (state) => {
          await page.goto(page.url())
          await expectPermissionBlocked(page)

          await clearPermissionDock(page, /allow once/i)
          await state.resolved()
          await page.goto(page.url())
          await expectPermissionOpen(page)
        },
      )
    },
    { trackSession: project.trackSession },
  )
})

test("blocked permission flow supports reject", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock permission reject",
    async (session) => {
      await project.gotoSession(session.id)
      await setAutoAccept(page, false)
      await withMockPermission(
        page,
        {
          id: "per_e2e_reject",
          sessionID: session.id,
          permission: "bash",
          patterns: ["/tmp/opencode-e2e-perm-reject"],
        },
        undefined,
        async (state) => {
          await page.goto(page.url())
          await expectPermissionBlocked(page)

          await clearPermissionDock(page, /deny/i)
          await state.resolved()
          await page.goto(page.url())
          await expectPermissionOpen(page)
        },
      )
    },
    { trackSession: project.trackSession },
  )
})

test("blocked permission flow supports allow always", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock permission always",
    async (session) => {
      await project.gotoSession(session.id)
      await setAutoAccept(page, false)
      await withMockPermission(
        page,
        {
          id: "per_e2e_always",
          sessionID: session.id,
          permission: "bash",
          patterns: ["/tmp/opencode-e2e-perm-always"],
          metadata: { description: "Need permission for command" },
        },
        undefined,
        async (state) => {
          await page.goto(page.url())
          await expectPermissionBlocked(page)

          await clearPermissionDock(page, /allow always/i)
          await state.resolved()
          await page.goto(page.url())
          await expectPermissionOpen(page)
        },
      )
    },
    { trackSession: project.trackSession },
  )
})

test("child session question request blocks parent dock and unblocks after submit", async ({ page, llm, project }) => {
  const questions = [
    {
      header: "Child input",
      question: "Pick one child option",
      options: [
        { label: "Continue", description: "Continue child" },
        { label: "Stop", description: "Stop child" },
      ],
    },
  ]
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock child question parent",
    async (session) => {
      await project.gotoSession(session.id)

      const child = await project.sdk.session
        .create({
          title: "e2e composer dock child question",
          parentID: session.id,
        })
        .then((r) => r.data)
      if (!child?.id) throw new Error("Child session create did not return an id")
      project.trackSession(child.id)

      try {
        await withDockSeed(project.sdk, child.id, async () => {
          await llm.toolMatch(inputMatch({ questions }), "question", { questions })
          await seedSessionQuestion(project.sdk, {
            sessionID: child.id,
            questions,
          })

          const dock = page.locator(questionDockSelector)
          await expectQuestionBlocked(page)

          await dock.locator('[data-slot="question-option"]').first().click()
          await dock.getByRole("button", { name: /submit/i }).click()

          await expectQuestionOpen(page)
        })
      } finally {
        await cleanupSession({ sdk: project.sdk, sessionID: child.id })
      }
    },
    { trackSession: project.trackSession },
  )
})

test("child session permission request blocks parent dock and supports allow once", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock child permission parent",
    async (session) => {
      await project.gotoSession(session.id)
      await setAutoAccept(page, false)

      const child = await project.sdk.session
        .create({
          title: "e2e composer dock child permission",
          parentID: session.id,
        })
        .then((r) => r.data)
      if (!child?.id) throw new Error("Child session create did not return an id")
      project.trackSession(child.id)

      try {
        await withMockPermission(
          page,
          {
            id: "per_e2e_child",
            sessionID: child.id,
            permission: "bash",
            patterns: ["/tmp/opencode-e2e-perm-child"],
            metadata: { description: "Need child permission" },
          },
          { child },
          async (state) => {
            await page.goto(page.url())
            await expectPermissionBlocked(page)

            await clearPermissionDock(page, /allow once/i)
            await state.resolved()
            await page.goto(page.url())

            await expectPermissionOpen(page)
          },
        )
      } finally {
        await cleanupSession({ sdk: project.sdk, sessionID: child.id })
      }
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock transitions and collapse behavior", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock todo",
    async (session) => {
      const dock = await todoDock(page, session.id)
      await project.gotoSession(session.id)
      await expect(page.locator(sessionComposerDockSelector)).toBeVisible()

      try {
        await dock.open([
          { content: "first task", status: "pending", priority: "high" },
          { content: "second task", status: "in_progress", priority: "medium" },
        ])
        await dock.expectCollapsed(["pending", "in_progress"])

        await dock.expand()
        await dock.expectOpen(["pending", "in_progress"])

        await dock.collapse()
        await dock.expectCollapsed(["pending", "in_progress"])

        await dock.finish([
          { content: "first task", status: "completed", priority: "high" },
          { content: "second task", status: "cancelled", priority: "medium" },
        ])
        await dock.expectCollapsed(["completed", "cancelled"])
      } finally {
        await dock.clear()
      }
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock auto-hides after all todos complete", async ({ page, project }) => {
  await project.open()
  await page.clock.install()
  await withDockSession(
    project.sdk,
    "e2e composer dock todo complete auto-hide",
    async (session) => {
      const dock = await todoDock(page, session.id)
      await project.gotoSession(session.id)

      try {
        await dock.open([
          { content: "first task", status: "pending", priority: "high" },
          { content: "second task", status: "in_progress", priority: "medium" },
        ])
        await dock.expectCollapsed(["pending", "in_progress"])

        await dock.finish([
          { content: "first task", status: "completed", priority: "high" },
          { content: "second task", status: "completed", priority: "medium" },
        ])
        await dock.expectState({ dock: true, completing: true, count: 2, states: ["completed", "completed"] })
        await page.clock.fastForward(3_000)
        await dock.expectState({ dock: false, completing: false, count: 2, states: ["completed", "completed"] })
        await dock.expectUnmounted()
        await dock.expectDockGone()
      } finally {
        await dock.clear()
      }
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock appears from real todowrite tool parts", async ({ page, llm, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock real todowrite",
    async (session) => {
      const dock = await todoDock(page, session.id)
      await project.gotoSession(session.id)

      await llm.tool("todowrite", {
        todos: [
          { content: "count to 0", status: "completed", priority: "high" },
          { content: "count to 1", status: "in_progress", priority: "medium" },
          { content: "count to 2", status: "pending", priority: "medium" },
        ],
      })
      await llm.text("counting started")

      await project.prompt("Create a todo list and start counting.")

      await dock.expectCollapsed(["completed", "in_progress", "pending"])
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock stays hidden when landing on an already completed session", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock todo completed landing source",
    async (sessionA) => {
      await withDockSession(
        project.sdk,
        "e2e composer dock todo completed landing target",
        async (sessionB) => {
          const dockA = await todoDock(page, sessionA.id)
          const dockB = await todoDock(page, sessionB.id)
          await project.gotoSession(sessionA.id)

          try {
            await dockB.finish([
              { content: "first task", status: "completed", priority: "high" },
              { content: "second task", status: "completed", priority: "medium" },
              { content: "third task", status: "completed", priority: "medium" },
              { content: "fourth task", status: "completed", priority: "low" },
            ])
            await project.gotoSession(sessionB.id)

            await dockB.expectState(
              {
                dock: false,
                completing: false,
                count: 4,
                states: ["completed", "completed", "completed", "completed"],
              },
              1_000,
            )
            await dockB.expectDockGone(1_000)
          } finally {
            await dockA.clear()
            await dockB.clear()
          }
        },
        { trackSession: project.trackSession },
      )
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock treats cancelled todos as terminal and labels all-cancelled progress", async ({ page, project }) => {
  await project.open()
  await page.clock.install()
  await withDockSession(
    project.sdk,
    "e2e composer dock todo cancelled auto-hide",
    async (session) => {
      const dock = await todoDock(page, session.id)
      await project.gotoSession(session.id)

      try {
        await dock.open([
          { content: "first task", status: "pending", priority: "high" },
          { content: "second task", status: "in_progress", priority: "medium" },
        ])
        await dock.expectCollapsed(["pending", "in_progress"])

        await dock.finish([
          { content: "first task", status: "cancelled", priority: "high" },
          { content: "second task", status: "cancelled", priority: "medium" },
        ])
        await expect(page.locator('[data-slot="session-todo-progress"]')).toHaveAttribute(
          "aria-label",
          enDict["session.todo.cancelled"],
        )
        await dock.expectState({ dock: true, completing: true, count: 2, states: ["cancelled", "cancelled"] })
        await page.clock.fastForward(3_000)
        await dock.expectState({ dock: false, completing: false, count: 2, states: ["cancelled", "cancelled"] })
        await dock.expectUnmounted()
      } finally {
        await dock.clear()
      }
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock hides immediately when todos become empty", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock todo empty hides",
    async (session) => {
      const dock = await todoDock(page, session.id)
      await project.gotoSession(session.id)

      try {
        await dock.open([{ content: "active task", status: "in_progress", priority: "high" }])
        await dock.expectCollapsed(["in_progress"])

        await dock.finish([])
        await dock.expectState({ dock: false, completing: false, count: 0, states: [] }, 1_000)
        await dock.expectUnmounted(1_000)
        await dock.expectDockGone(1_000)
      } finally {
        await dock.clear()
      }
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock does not treat completed-only todos as recent after clearing", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock todo empty clears active history",
    async (session) => {
      const dock = await todoDock(page, session.id)
      await project.gotoSession(session.id)

      try {
        await dock.open([{ content: "active task", status: "in_progress", priority: "high" }])
        await dock.expectState({ dock: true, completing: false, count: 1, states: ["in_progress"] })

        await dock.finish([])
        await dock.expectState({ dock: false, completing: false, count: 0, states: [] }, 1_000)

        await dock.finish([{ content: "historical done task", status: "completed", priority: "high" }])
        await dock.expectState({ dock: false, completing: false, count: 1, states: ["completed"] }, 1_000)
        await dock.expectDockGone(1_000)
      } finally {
        await dock.clear()
      }
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock cancels pending hide when a new active todo arrives", async ({ page, project }) => {
  await project.open()
  await page.clock.install()
  await withDockSession(
    project.sdk,
    "e2e composer dock todo hide cancelled",
    async (session) => {
      const dock = await todoDock(page, session.id)
      await project.gotoSession(session.id)

      try {
        await dock.open([{ content: "done task", status: "in_progress", priority: "high" }])
        await dock.expectState({ dock: true, completing: false, count: 1, states: ["in_progress"] })

        await dock.finish([{ content: "done task", status: "completed", priority: "high" }])
        await dock.expectState({ dock: true, completing: true, count: 1, states: ["completed"] })

        await dock.finish([
          { content: "done task", status: "completed", priority: "high" },
          { content: "new task", status: "pending", priority: "medium" },
        ])
        await dock.expectState({ dock: true, completing: false, count: 2, states: ["completed", "pending"] })
        await page.clock.fastForward(3_500)
        await dock.expectState({ dock: true, completing: false, count: 2, states: ["completed", "pending"] })
      } finally {
        await dock.clear()
      }
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock restarts the hide timer when todos re-complete", async ({ page, project }) => {
  await project.open()
  await page.clock.install()
  await withDockSession(
    project.sdk,
    "e2e composer dock todo timer reset",
    async (session) => {
      const dock = await todoDock(page, session.id)
      await project.gotoSession(session.id)

      try {
        await dock.open([{ content: "first task", status: "in_progress", priority: "high" }])
        await dock.expectState({ dock: true, completing: false, count: 1, states: ["in_progress"] })

        await dock.finish([{ content: "first task", status: "completed", priority: "high" }])
        await dock.expectState({ dock: true, completing: true, count: 1, states: ["completed"] })

        await page.clock.fastForward(2_400)
        await dock.finish([
          { content: "first task", status: "completed", priority: "high" },
          { content: "second task", status: "pending", priority: "medium" },
        ])
        await dock.expectState({ dock: true, completing: false, count: 2, states: ["completed", "pending"] })

        await dock.finish([
          { content: "first task", status: "completed", priority: "high" },
          { content: "second task", status: "completed", priority: "medium" },
        ])
        await dock.expectState({ dock: true, completing: true, count: 2, states: ["completed", "completed"] })
        await page.clock.fastForward(2_500)
        await dock.expectState({ dock: true, completing: true, count: 2, states: ["completed", "completed"] })
        await page.clock.fastForward(500)
        await dock.expectState({ dock: false, completing: false, count: 2, states: ["completed", "completed"] })
      } finally {
        await dock.clear()
      }
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock does not leak a pending hide timeout across sessions", async ({ page, project }) => {
  await project.open()
  await page.clock.install()
  await withDockSession(
    project.sdk,
    "e2e composer dock todo session switch source",
    async (sessionA) => {
      await withDockSession(
        project.sdk,
        "e2e composer dock todo session switch target",
        async (sessionB) => {
          const dockA = await todoDock(page, sessionA.id)
          const dockB = await todoDock(page, sessionB.id)
          await project.gotoSession(sessionA.id)

          try {
            await dockA.open([{ content: "done task", status: "in_progress", priority: "high" }])
            await dockA.expectState({ dock: true, completing: false, count: 1, states: ["in_progress"] })

            await dockA.finish([{ content: "done task", status: "completed", priority: "high" }])
            await dockA.expectState({ dock: true, completing: true, count: 1, states: ["completed"] })

            await project.gotoSession(sessionB.id)
            await dockB.expectState({ dock: false, completing: false, count: 0, states: [] })

            await page.clock.fastForward(3_500)
            await project.gotoSession(sessionA.id)
            await dockA.expectState({ dock: false, completing: false, count: 1, states: ["completed"] })
          } finally {
            await dockA.clear()
            await dockB.clear()
          }
        },
        { trackSession: project.trackSession },
      )
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock stays hidden after same-count terminal session switch", async ({ page, project }) => {
  await project.open()
  await page.clock.install()
  await withDockSession(
    project.sdk,
    "e2e composer dock terminal switch source",
    async (sessionA) => {
      await withDockSession(
        project.sdk,
        "e2e composer dock terminal switch target",
        async (sessionB) => {
          const dockA = await todoDock(page, sessionA.id)
          const dockB = await todoDock(page, sessionB.id)
          await project.gotoSession(sessionA.id)

          try {
            await dockA.open([{ content: "source done", status: "in_progress", priority: "high" }])
            await dockA.expectState({ dock: true, completing: false, count: 1, states: ["in_progress"] })

            await dockA.finish([{ content: "source done", status: "completed", priority: "high" }])
            await dockA.expectState({ dock: true, completing: true, count: 1, states: ["completed"] })

            await page.clock.fastForward(2_400)

            await dockB.open([{ content: "target done", status: "completed", priority: "high" }])
            await project.gotoSession(sessionB.id)
            await dockB.expectState({ dock: false, completing: false, count: 1, states: ["completed"] })

            await page.clock.fastForward(900)
            await dockB.expectState({ dock: false, completing: false, count: 1, states: ["completed"] })
            await page.clock.fastForward(2_100)
            await dockB.expectState({ dock: false, completing: false, count: 1, states: ["completed"] })
          } finally {
            await dockA.clear()
            await dockB.clear()
          }
        },
        { trackSession: project.trackSession },
      )
    },
    { trackSession: project.trackSession },
  )
})

test("e2e composer dock keeps latest turn visible when dock height changes", async ({ page, project, assistant }) => {
  const title = `e2e composer scroll dock ${Date.now()}`
  const longReply = [
    "Here's the smoke test message counting from 1 to 100:",
    "",
    "```",
    ...Array.from({ length: 100 }, (_, index) => `${index + 1}`),
    "```",
    "",
    "Smoke test complete! This output demonstrates:",
    "",
    "- 100 lines of sequential numeric output",
    "- No files were created or modified",
    "- Each number appears on its own line as requested",
  ].join("\n")

  await project.open()
  await withDockSession(
    project.sdk,
    title,
    async (session) => {
      const dock = await todoDock(page, session.id)
      await project.gotoSession(session.id)
      await assistant.reply(longReply)

      await project.prompt("Write a long visible response for scroll dock testing.")

      await dock.open([
        { content: "first scroll dock task", status: "pending" },
        { content: "second scroll dock task", status: "pending" },
        { content: "third scroll dock task", status: "pending" },
      ])

      const metrics = await page.evaluate(() => {
        const viewport = document.querySelector('[data-component="scroll-viewport"]')
        const composer = document.querySelector('[data-component="session-prompt-dock"]')
        const last = [...document.querySelectorAll("[data-message-id]")].at(-1)
        if (
          !(viewport instanceof HTMLElement) ||
          !(composer instanceof HTMLElement) ||
          !(last instanceof HTMLElement)
        ) {
          return null
        }
        viewport.scrollTop = viewport.scrollHeight
        const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT)
        let tail: Text | null = null
        while (walker.nextNode()) {
          const node = walker.currentNode
          if (node.textContent?.includes("Each number appears on its own line as requested")) tail = node as Text
        }
        if (!tail) return null
        const range = document.createRange()
        range.selectNodeContents(tail)
        const composerTop = composer.getBoundingClientRect().top
        const lastBottom = last.getBoundingClientRect().bottom
        const tailBottom = range.getBoundingClientRect().bottom
        range.detach()
        return {
          scrollTop: viewport.scrollTop,
          messageDistance: composerTop - lastBottom,
          tailDistance: composerTop - tailBottom,
        }
      })

      expect(metrics).not.toBeNull()
      expect(metrics!.messageDistance).toBeGreaterThanOrEqual(0)
      expect(metrics!.tailDistance).toBeGreaterThanOrEqual(0)

      const before = metrics!.scrollTop
      const viewport = page.locator('[data-component="scroll-viewport"]').first()
      await viewport.hover()
      await page.mouse.wheel(0, -360)

      await expect
        .poll(async () => {
          return page.evaluate(() => {
            const viewport = document.querySelector('[data-component="scroll-viewport"]')
            if (!(viewport instanceof HTMLElement)) return 0
            return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
          })
        })
        .toBeGreaterThan(120)

      const distanceBeforeExpansion = await page.evaluate(() => {
        const viewport = document.querySelector('[data-component="scroll-viewport"]')
        if (!(viewport instanceof HTMLElement)) return 0
        return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
      })

      await dock.open([
        { content: "first scroll dock task", status: "pending" },
        { content: "second scroll dock task", status: "pending" },
        { content: "third scroll dock task", status: "pending" },
        { content: "fourth scroll dock task expands height", status: "pending" },
        { content: "fifth scroll dock task expands height", status: "pending" },
      ])

      let afterUserScroll: { scrollTop: number; distanceFromBottom: number } | null = null
      await expect
        .poll(async () => {
          afterUserScroll = await page.evaluate(() => {
            const viewport = document.querySelector('[data-component="scroll-viewport"]')
            if (!(viewport instanceof HTMLElement)) return null
            return {
              scrollTop: viewport.scrollTop,
              distanceFromBottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
            }
          })
          return afterUserScroll?.distanceFromBottom ?? -1
        })
        .toBeGreaterThanOrEqual(distanceBeforeExpansion - 40)

      expect(afterUserScroll).not.toBeNull()
      expect(afterUserScroll!.scrollTop).toBeLessThan(before)

      await mkdir(".artifacts/session-scroll-dock", { recursive: true })
      await page.screenshot({ path: ".artifacts/session-scroll-dock/latest-visible.png" })
    },
    { trackSession: project.trackSession },
  )
})

test("keyboard focus stays off prompt while blocked", async ({ page, llm, project }) => {
  const questions = [
    {
      header: "Need input",
      question: "Pick one option",
      options: [{ label: "Continue", description: "Continue now" }],
    },
  ]
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock keyboard",
    async (session) => {
      await withDockSeed(project.sdk, session.id, async () => {
        await project.gotoSession(session.id)

        await llm.toolMatch(inputMatch({ questions }), "question", { questions })
        await seedSessionQuestion(project.sdk, {
          sessionID: session.id,
          questions,
        })

        await expectQuestionBlocked(page)

        await page.locator("main").click({ position: { x: 5, y: 5 } })
        await page.keyboard.type("abc")
        await expect(page.locator(promptSelector)).toHaveCount(0)
      })
    },
    { trackSession: project.trackSession },
  )
})

test("question text renders source newlines as visible line breaks", async ({ page, llm, project }) => {
  // Behavior guard: seed a question with paragraph breaks (\n\n) in the source and
  // assert the rendered innerText still contains multiple non-empty lines. If a
  // future CSS refactor drops white-space: pre-wrap on [data-slot="question-text"]
  // the browser will collapse the \n into spaces and innerText returns one line.
  // Testing the rendered behavior (line count) instead of the CSS mechanism keeps
  // the test valid if the implementation switches to a different technique that
  // also preserves paragraph breaks.
  await project.open()
  const MULTILINE_QUESTIONS = [
    {
      header: "Multiline",
      question: "First paragraph\n\nSecond paragraph",
      options: [{ label: "OK", description: "ack" }],
    },
  ]
  await withDockSession(
    project.sdk,
    "e2e question multiline",
    async (session) => {
      await withDockSeed(project.sdk, session.id, async () => {
        await project.gotoSession(session.id)
        await llm.toolMatch(inputMatch({ questions: MULTILINE_QUESTIONS }), "question", {
          questions: MULTILINE_QUESTIONS,
        })
        await seedSessionQuestion(project.sdk, { sessionID: session.id, questions: MULTILINE_QUESTIONS })

        const dock = page.locator(questionDockSelector)
        const text = dock.locator('[data-slot="question-text"]')
        const rendered = await text.evaluate((el) => (el as HTMLElement).innerText)
        const nonEmptyLines = rendered.split(/\r?\n/).filter((line) => line.trim().length > 0)
        expect(nonEmptyLines.length).toBeGreaterThanOrEqual(2)
        expect(rendered).toContain("First paragraph")
        expect(rendered).toContain("Second paragraph")
      })
    },
    { trackSession: project.trackSession },
  )
})
