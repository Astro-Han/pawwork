import type { Page } from "@playwright/test"
import type { PermissionRequest, Todo } from "@opencode-ai/sdk/v2/client"
import { test, expect } from "../fixtures"
import {
  composerEvent,
  type ComposerDriverState,
  type ComposerProbeState,
  type ComposerStateProbeState,
  type ComposerWindow,
} from "../../src/testing/session-composer"
import {
  cleanupSession,
  clearSessionDockSeed,
  closeSettingsPanel,
  openSettings,
  openSidebar,
  seedSessionQuestion,
} from "../actions"
import {
  permissionDockSelector,
  promptSelector,
  questionDockSelector,
  scrollViewportSelector,
  sessionComposerDockSelector,
  sessionTurnListSelector,
  sessionTodoToggleButtonSelector,
  titlebarRightSelector,
} from "../selectors"
import { modKey } from "../utils"
import { inputMatch } from "../prompt/mock"
import { dict as enDict } from "../../src/i18n/en"

type Sdk = Parameters<typeof clearSessionDockSeed>[0]
type PermissionRule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" }
type ProjectQuestionSeed = {
  url: string
  directory: string
  sdk: Sdk
}

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

async function seedSessionTurns(input: { sdk: Sdk; sessionID: string; count: number }) {
  for (let i = 0; i < input.count; i++) {
    await input.sdk.session.promptAsync({
      sessionID: input.sessionID,
      noReply: true,
      parts: [
        {
          type: "text",
          text: `composer dock seed ${i}\n${Array.from({ length: 16 }, (_, line) => `line ${line} ${"content ".repeat(8)}`).join("\n")}`,
        },
      ],
    })
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

function globalEventStream(page: Page) {
  return {
    cursor: () =>
      page.evaluate(() => {
        const win = window as Window & {
          __opencode_e2e?: { globalEventStream?: { cursor: () => string | undefined } }
        }
        return win.__opencode_e2e?.globalEventStream?.cursor()
      }),
    stop: () =>
      page.evaluate(() => {
        const win = window as Window & {
          __opencode_e2e?: { globalEventStream?: { stop: () => void } }
        }
        win.__opencode_e2e?.globalEventStream?.stop()
      }),
    start: () =>
      page.evaluate(() => {
        const win = window as Window & {
          __opencode_e2e?: { globalEventStream?: { start: () => void } }
        }
        win.__opencode_e2e?.globalEventStream?.start()
      }),
    setCursorForTest: (value: string | undefined) =>
      page.evaluate((value) => {
        const win = window as Window & {
          __opencode_e2e?: { globalEventStream?: { setCursorForTest: (value: string | undefined) => void } }
        }
        const hook = win.__opencode_e2e?.globalEventStream?.setCursorForTest
        if (!hook) throw new Error("Missing e2e global event stream cursor override hook")
        hook(value)
      }, value),
  }
}

async function e2eAskPermission(
  project: ProjectQuestionSeed,
  input: {
    sessionID: string
    permission: string
    patterns: string[]
    metadata?: Record<string, unknown>
    always?: string[]
  },
) {
  const response = await fetch(
    `${project.url}/permission/__e2e/ask?directory=${encodeURIComponent(project.directory)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  )
  expect(response.status).toBe(204)
}

async function e2eUpdateTodos(
  project: ProjectQuestionSeed,
  input: { sessionID: string; todos: Array<Pick<Todo, "content" | "status" | "priority"> & Partial<Pick<Todo, "id">>> },
) {
  const response = await fetch(
    `${project.url}/session/__e2e/update-todos?directory=${encodeURIComponent(project.directory)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  )
  expect(response.status, await response.text()).toBe(204)
}

async function waitForPermissionSeed(
  project: ProjectQuestionSeed,
  input: { sessionID: string; permission: string; pattern: string },
) {
  let current: PermissionRequest | undefined
  await expect
    .poll(
      async () => {
        const permissions = await project.sdk.permission.list().then((response) => response.data ?? [])
        current = permissions.find(
          (permission) =>
            permission.sessionID === input.sessionID &&
            permission.permission === input.permission &&
            permission.patterns.includes(input.pattern),
        )
        return !!current
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  if (!current) throw new Error("Permission seed was not visible after polling")
  return current
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

async function submitVisiblePrompt(page: Page, text: string) {
  const prompt = page.locator(promptSelector).first()
  await expect(prompt).toBeVisible()
  await prompt.click()
  await page.keyboard.type(text)
  await expect.poll(async () => (await prompt.textContent())?.replace(/\u200B/g, "").trim()).toBe(text)
  await page.keyboard.press("Enter")
}

async function readPromptSend(page: Page) {
  return page.evaluate(() => {
    const win = window as ComposerWindow
    const sent = win.__opencode_e2e?.prompt?.sent
    return {
      count: sent?.count ?? 0,
      sessionID: sent?.sessionID,
    }
  })
}

async function scrollTimelineToBottom(page: Page) {
  await page.evaluate(() => {
    const viewport = document.querySelector('[data-component="scroll-viewport"]')
    if (!(viewport instanceof HTMLElement)) throw new Error("Missing scroll viewport")
    viewport.scrollTop = viewport.scrollHeight
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const viewport = document.querySelector('[data-component="scroll-viewport"]')
        if (!(viewport instanceof HTMLElement)) return Number.POSITIVE_INFINITY
        return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
      })
    })
    .toBeLessThanOrEqual(40)
}

async function expectQuestionOptionVisible(page: Page, optionIndex: number) {
  await expect
    .poll(async () => {
      return page.evaluate((index) => {
        const list = document.querySelector('[data-slot="question-options"]')
        const target = list?.querySelectorAll('[data-slot="question-option"]').item(index)
        if (!(list instanceof HTMLElement) || !(target instanceof HTMLElement)) return null
        const active = document.activeElement
        const optionRect = target.getBoundingClientRect()
        const listRect = list.getBoundingClientRect()
        return {
          focused: active === target || !!target.contains(active),
          topVisible: optionRect.top >= listRect.top,
          bottomVisible: optionRect.bottom <= listRect.bottom,
        }
      }, optionIndex)
    })
    .toMatchObject({ focused: true, topVisible: true, bottomVisible: true })
}

async function expectQuestionOptionsOverflow(page: Page) {
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const list = document.querySelector('[data-slot="question-options"]')
        if (!(list instanceof HTMLElement)) return false
        return list.scrollHeight > list.clientHeight
      })
    })
    .toBe(true)
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
    readState,
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

test("permission dock recovers after invalid replay cursor forces fallback refresh", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock permission invalid cursor fallback",
    async (session) => {
      await withDockSeed(project.sdk, session.id, async () => {
        await project.gotoSession(session.id)
        await expect(page.locator(promptSelector)).toBeVisible()

        const stream = globalEventStream(page)
        const pattern = "/tmp/opencode-e2e-perm-replay-fallback"

        await expect.poll(stream.cursor, { timeout: 10_000 }).toMatch(/:/)
        await stream.stop()
        await e2eAskPermission(project, {
          sessionID: session.id,
          permission: "bash",
          patterns: [pattern],
          metadata: { description: "Need permission for replay fallback" },
        })
        await waitForPermissionSeed(project, { sessionID: session.id, permission: "bash", pattern })

        await expect(page.locator(permissionDockSelector)).toHaveCount(0, { timeout: 750 })
        await stream.setCursorForTest("bad:999")
        await expect.poll(stream.cursor, { timeout: 5_000 }).toBe("bad:999")
        await stream.start()

        await expectPermissionBlocked(page)
        await expect(page.locator(permissionDockSelector)).toHaveCount(1)
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

test("child question dock survives parent-page reload via external-result hydrate", async ({ page, llm, project }) => {
  // Regression: deleting question.asked / replied / rejected from the SSE
  // replay buffer (Stage 6) made the new message.part.updated path the only
  // signal that a question is pending. SSE message.part.updated is not in
  // the replay list, so a parent-page reload (or any cold open) would lose
  // the child agent's question dock. The fix is the GET /external-result/
  // pending hydrate fetched during bootstrap; this test guards that path.
  const questions = [
    {
      header: "Reload check",
      question: "Pick after reload",
      options: [
        { label: "Continue", description: "Continue child" },
        { label: "Stop", description: "Stop child" },
      ],
    },
  ]
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock child question reload",
    async (session) => {
      await project.gotoSession(session.id)

      const child = await project.sdk.session
        .create({
          title: "e2e composer dock child question reload",
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

          // Hard reload: clears the in-memory SolidJS store and starts a
          // fresh SSE connection (no replay cursor). The dock can only come
          // back via the bootstrap GET /external-result/pending fetch.
          await page.goto(page.url())
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

test("todo dock keeps the original hide timer during terminal-only refreshes", async ({ page, project }) => {
  await project.open()
  await page.clock.install()
  await withDockSession(
    project.sdk,
    "e2e composer dock todo unchanged terminal refresh",
    async (session) => {
      const dock = await todoDock(page, session.id)
      await project.gotoSession(session.id)

      try {
        await dock.open([
          { content: "first task", status: "pending", priority: "high" },
          { content: "second task", status: "in_progress", priority: "medium" },
          { content: "third task", status: "pending", priority: "medium" },
          { content: "fourth task", status: "pending", priority: "low" },
        ])
        await dock.expectCollapsed(["pending", "in_progress", "pending", "pending"])

        const completed = [
          { content: "first task", status: "completed", priority: "high" },
          { content: "second task", status: "completed", priority: "medium" },
          { content: "third task", status: "completed", priority: "medium" },
          { content: "fourth task", status: "completed", priority: "low" },
        ] as const

        await dock.finish([
          { ...completed[0], content: "first task done" },
          { ...completed[1], content: "second task done" },
          { ...completed[2], content: "third task done" },
          { ...completed[3], content: "fourth task done" },
        ])
        await dock.expectState({ dock: true, completing: true, count: 4 })
        await page.clock.fastForward(2_500)

        await dock.finish([...completed])
        await dock.expectState({ dock: true, completing: true, count: 4 })
        await page.clock.fastForward(500)

        await dock.expectState({ dock: false, completing: false, count: 4 })
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

      await dock.expectState({ dock: true, count: 3, states: ["completed", "in_progress", "pending"] }, 30_000)
      expect((await dock.readState())?.openingSamples).toContain(true)
      await dock.expectCollapsed(["completed", "in_progress", "pending"])
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock and status summary use backend terminal update over stale todowrite parts", async ({
  page,
  llm,
  project,
}) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock backend terminal todo",
    async (session) => {
      const content = "backend terminal todo"
      await project.gotoSession(session.id)

      await llm.tool("todowrite", {
        todos: [{ content, status: "in_progress", priority: "medium" }],
      })
      await llm.text("todo started")
      await project.prompt("Create a todo and start it.")

      const dockItem = page.locator('[data-slot="session-todo-item"]').filter({ hasText: content }).first()
      await expect(dockItem).toHaveAttribute("data-state", "in_progress", { timeout: 30_000 })

      await e2eUpdateTodos(
        { url: project.url, directory: project.directory, sdk: project.sdk },
        {
          sessionID: session.id,
          todos: [{ content, status: "completed", priority: "medium" }],
        },
      )

      await expect(dockItem).toHaveAttribute("data-state", "completed", { timeout: 10_000 })

      const rightPanel = page.locator("#right-panel")
      if ((await rightPanel.getAttribute("aria-hidden")) !== "false") {
        await page.locator(`${titlebarRightSelector} button`).first().click()
      }
      await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
      const summaryTodo = rightPanel.locator('[data-slot="status-summary-todo"]').filter({ hasText: content }).first()
      await expect(summaryTodo).toHaveAttribute("data-state", "completed", { timeout: 10_000 })
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock and status summary clear when backend todo update is empty", async ({ page, llm, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock backend empty todo",
    async (session) => {
      const content = "backend cleared todo"
      await project.gotoSession(session.id)

      await llm.tool("todowrite", {
        todos: [{ content, status: "in_progress", priority: "medium" }],
      })
      await llm.text("todo started")
      await project.prompt("Create a todo and start it.")

      const dockItem = page.locator('[data-slot="session-todo-item"]').filter({ hasText: content })
      await expect(dockItem.first()).toHaveAttribute("data-state", "in_progress", { timeout: 30_000 })

      await e2eUpdateTodos(
        { url: project.url, directory: project.directory, sdk: project.sdk },
        {
          sessionID: session.id,
          todos: [],
        },
      )

      await expect(dockItem).toHaveCount(0, { timeout: 10_000 })

      const rightPanel = page.locator("#right-panel")
      if ((await rightPanel.getAttribute("aria-hidden")) !== "false") {
        await page.locator(`${titlebarRightSelector} button`).first().click()
      }
      await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
      await expect(rightPanel.locator('[data-slot="status-summary-todo"]').filter({ hasText: content })).toHaveCount(0)
    },
    { trackSession: project.trackSession },
  )
})

test("todo dock appears for the first todowrite in a fresh session", async ({ page, llm, project }) => {
  await project.open()

  await llm.tool("todowrite", {
    todos: [
      { content: "fresh first todo", status: "in_progress", priority: "high" },
      { content: "fresh follow-up todo", status: "pending", priority: "medium" },
    ],
  })
  await llm.text("fresh todo started")

  const before = await readPromptSend(page)
  await submitVisiblePrompt(page, "Create todos in a fresh session.")
  const sent = await expect
    .poll(async () => readPromptSend(page), { timeout: 30_000 })
    .toMatchObject({ count: before.count + 1 })
    .then(() => readPromptSend(page))
  if (!sent.sessionID) throw new Error("Prompt submission did not expose a session id")

  const dock = page.locator('[data-component="session-todo-dock"]')

  await expect(dock).toHaveCount(1, { timeout: 30_000 })
  await expect(dock).toContainText("fresh first todo", { timeout: 30_000 })
  project.trackSession(sent.sessionID)
})

test("todo dock recovers after missed todowrite via SSE replay", async ({ page, llm, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock todowrite replay",
    async (session) => {
      const dock = await todoDock(page, session.id)
      await project.gotoSession(session.id)

      const stream = globalEventStream(page)
      await expect.poll(stream.cursor, { timeout: 10_000 }).toMatch(/:/)
      await stream.stop()

      await llm.tool("todowrite", {
        todos: [{ content: "missed live todo", status: "in_progress", priority: "high" }],
      })
      await llm.text("todo started while stream was stopped")
      await project.prompt("Create a todo while the event stream is paused.")

      await expect(page.locator('[data-component="session-todo-dock"]')).toHaveCount(0, { timeout: 750 })
      await stream.start()

      await dock.expectCollapsed(["in_progress"])
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

test("todo dock does not flash on home after navigating from a session", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock no home flash",
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
        await expect(page.locator('[data-component="session-todo-dock"]')).toBeVisible()

        await page.evaluate(() => {
          const SELECTOR = '[data-component="session-todo-dock"]'
          const records: string[] = []
          const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
              for (const node of Array.from(m.addedNodes)) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue
                const el = node as Element
                if (el.matches(SELECTOR) || el.querySelector(SELECTOR)) {
                  records.push(el.outerHTML.slice(0, 200))
                }
              }
            }
          })
          observer.observe(document.body, { childList: true, subtree: true })
          ;(
            window as unknown as {
              __todoDockObserver: { observer: MutationObserver; records: string[] }
            }
          ).__todoDockObserver = { observer, records }
        })

        await openSidebar(page)
        await page.locator('[data-action="pawwork-session-new"]').click()
        await expect(page.locator('[data-component="session-new-home"]')).toBeVisible()

        const flashes = await page.evaluate(() => {
          const w = window as unknown as {
            __todoDockObserver?: { observer: MutationObserver; records: string[] }
          }
          const o = w.__todoDockObserver
          if (!o) return null
          o.observer.disconnect()
          delete w.__todoDockObserver
          return o.records
        })

        expect(flashes, "session-todo-dock must not appear on home during the transition").toEqual([])
        await expect(page.locator('[data-component="session-todo-dock"]')).toHaveCount(0)
      } finally {
        await dock.clear()
      }
    },
    { trackSession: project.trackSession },
  )
})

test("submit to question dock keeps latest turn visible", async ({ page, llm, project, assistant }) => {
  const title = `e2e question scroll dock ${Date.now()}`
  const longReply = [
    "Question dock scroll regression seed:",
    "",
    "```",
    ...Array.from({ length: 150 }, (_, index) => `visible-history-line-${index + 1}`),
    "```",
    "",
    "End of visible history.",
  ].join("\n")
  const questionPrompt = [
    "Call exactly one question tool.",
    `Use this JSON input: ${JSON.stringify({ questions: defaultQuestions })}`,
    "Do not output plain text.",
  ].join(" ")

  await project.open()
  await withDockSession(
    project.sdk,
    title,
    async (session) => {
      await withDockSeed(project.sdk, session.id, async () => {
        await project.gotoSession(session.id)
        await assistant.reply(longReply)
        await project.prompt("Write long visible history for the question scroll regression.")
        await scrollTimelineToBottom(page)

        await llm.toolMatch(inputMatch({ questions: defaultQuestions }), "question", { questions: defaultQuestions })
        await submitVisiblePrompt(page, questionPrompt)
        await expectQuestionBlocked(page)

        const metrics = await page.evaluate((dockSelector) => {
          const viewport = document.querySelector('[data-component="scroll-viewport"]')
          const dock = document.querySelector(dockSelector)
          const last = [...document.querySelectorAll("[data-message-id]")].at(-1)
          if (!(viewport instanceof HTMLElement) || !(dock instanceof HTMLElement) || !(last instanceof HTMLElement)) {
            return null
          }
          return {
            scrollTop: viewport.scrollTop,
            distanceFromBottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
            dockTop: dock.getBoundingClientRect().top,
            viewportBottom: viewport.getBoundingClientRect().bottom,
            lastBottom: last.getBoundingClientRect().bottom,
          }
        }, questionDockSelector)

        expect(metrics).not.toBeNull()
        expect(metrics!.scrollTop).toBeGreaterThan(100)
        expect(metrics!.distanceFromBottom).toBeLessThanOrEqual(80)
        expect(metrics!.dockTop).toBeLessThanOrEqual(metrics!.viewportBottom)
        expect(metrics!.lastBottom).toBeLessThanOrEqual(metrics!.dockTop + 8)
      })
    },
    { trackSession: project.trackSession },
  )
})

test("overflow question dock keeps keyboard focus visible without moving timeline", async ({
  page,
  project,
  assistant,
  llm,
}) => {
  const title = `e2e question overflow dock ${Date.now()}`
  const overflowQuestions = [
    {
      header: "Need input",
      question:
        "Pick one option after reading this longer prompt. The content is intentionally long enough to make the compact question dock reserve less room for the option list in a short viewport.",
      custom: false,
      options: Array.from({ length: 4 }, (_, index) => ({
        label: `Option ${index + 1}`,
        description: `Long option ${index + 1} description that fills the row.`,
      })),
    },
  ]
  const longReply = [
    "Question dock overflow regression seed:",
    "",
    "```",
    ...Array.from({ length: 150 }, (_, index) => `visible-history-line-${index + 1}`),
    "```",
    "",
    "End of visible history.",
  ].join("\n")

  await page.setViewportSize({ width: 1280, height: 420 })
  await project.open()
  await withDockSession(
    project.sdk,
    title,
    async (session) => {
      await withDockSeed(project.sdk, session.id, async () => {
        await project.gotoSession(session.id)
        await assistant.reply(longReply)
        await project.prompt("Write long visible history for the question overflow regression.")
        await scrollTimelineToBottom(page)

        await llm.toolMatch(inputMatch({ questions: overflowQuestions }), "question", { questions: overflowQuestions })
        await seedSessionQuestion(project.sdk, { sessionID: session.id, questions: overflowQuestions })
        await expectQuestionBlocked(page)
        await expectQuestionOptionsOverflow(page)

        await page.locator(`${questionDockSelector} [data-slot="question-option"]`).first().focus()
        await page.keyboard.press("End")
        await expectQuestionOptionVisible(page, overflowQuestions[0].options.length - 1)
        const distanceAfterEnd = await page.evaluate(() => {
          const viewport = document.querySelector('[data-component="scroll-viewport"]')
          if (!(viewport instanceof HTMLElement)) return Number.POSITIVE_INFINITY
          return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
        })
        expect(distanceAfterEnd).toBeLessThanOrEqual(80)
      })
    },
    { trackSession: project.trackSession },
  )
})

test("keyboard focus stays off prompt while blocked", async ({ page, llm, project }) => {
  const questions = [
    {
      header: "Need input",
      question: "Pick one option",
      options: [
        { label: "Continue", description: "Continue now" },
        { label: "Stop", description: "Stop here" },
      ],
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
      options: [
        { label: "OK", description: "ack" },
        { label: "Cancel", description: "skip" },
      ],
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

// Cancelling a session while a question tool is awaiting an answer must clear
// the dock AND surface a friendly hint in the message stream so the user is
// not left staring at a stuck UI. See #419.
test("cancelled question tool surfaces interrupted hint in message stream", async ({ page, llm, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock question cancelled",
    async (session) => {
      await withDockSeed(project.sdk, session.id, async () => {
        await project.gotoSession(session.id)

        await llm.toolMatch(inputMatch({ questions: defaultQuestions }), "question", { questions: defaultQuestions })
        await seedSessionQuestion(project.sdk, {
          sessionID: session.id,
          questions: defaultQuestions,
        })

        await expectQuestionBlocked(page)

        await project.sdk.session.abort({ sessionID: session.id })

        // Dock disappears via the live `question.rejected` SSE event published
        // by Question.ask's abort handler — no reload needed for this leg.
        await expect(page.locator(questionDockSelector)).toHaveCount(0, { timeout: 10_000 })

        // The message stream isn't subscribed to mid-session message updates
        // in this dock-focused test setup (matching the permission-flow tests
        // which also reload before asserting on tool-result UI). Reload so the
        // initial render walks the full message history and our error tool
        // part with `metadata.interrupted = true` lands.
        await page.goto(page.url())

        // Hint string lives in packages/ui/src/i18n/en.ts (not the app dict);
        // hardcode it here as the contract anchor for this fix.
        await expect(
          page.getByText(
            "This question was cancelled before it was answered. Ask again below if you want to continue.",
          ),
        ).toBeVisible({ timeout: 10_000 })
      })
    },
    { trackSession: project.trackSession },
  )
})
