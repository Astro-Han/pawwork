import type { Page } from "@playwright/test"
import type { PermissionRequest, Todo } from "@opencode-ai/sdk/v2/client"
import { test, expect } from "../fixtures"
import {
  cleanupSession,
  clearSessionDockSeed,
  openRightPanel,
  rightPanelTabList,
  seedSessionQuestion,
} from "../actions"
import {
  permissionDockSelector,
  promptSelector,
  questionDockSelector,
  scrollViewportSelector,
  sessionComposerDockSelector,
  sessionTurnListSelector,
} from "../selectors"
import { modKey } from "../utils"
import { inputMatch } from "../prompt/mock"

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

test("blocked question dock disables controls while response is pending", async ({ page, llm, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e composer dock question pending disabled",
    async (session) => {
      await withDockSeed(project.sdk, session.id, async () => {
        await project.gotoSession(session.id)

        let responseCalls = 0
        let releaseResponse: (() => void) | undefined
        const responseReleased = new Promise<void>((resolve) => {
          releaseResponse = resolve
        })
        const respondRoute = async (route: any) => {
          responseCalls += 1
          await responseReleased
          await route
            .fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(true) })
            .catch(() => undefined)
        }

        try {
          const questions = defaultQuestions
          await llm.toolMatch(inputMatch({ questions }), "question", { questions })
          await seedSessionQuestion(project.sdk, {
            sessionID: session.id,
            questions,
          })

          const dock = page.locator(questionDockSelector)
          await expectQuestionBlocked(page)

          await page.route("**/session/*/tool/respond", respondRoute)

          const customOption = dock.locator('[data-slot="question-option"][data-custom="true"]')
          await customOption.click()

          const customInput = dock.locator('[data-slot="question-custom-input"]')
          const firstOption = dock.locator('[data-slot="question-option"]').first()
          const submit = dock.getByRole("button", { name: /submit/i })
          await expect(customInput).toBeVisible()

          await dock.evaluate((el) => {
            el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
          })
          await expect.poll(() => responseCalls, { timeout: 10_000 }).toBe(1)

          await expect(customInput).toBeDisabled()
          await expect(firstOption).toBeDisabled()
          await expect(submit).toBeDisabled()

          const duplicateResponse = page
            .waitForRequest((request) => request.url().includes("/tool/respond"), { timeout: 1_000 })
            .then(() => true)
            .catch(() => false)
          await dock.evaluate((el) => {
            el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
          })
          await submit.evaluate((button: HTMLButtonElement) => button.click())
          await firstOption.evaluate((button: HTMLButtonElement) => button.click())
          expect(await duplicateResponse).toBe(false)
          expect(responseCalls).toBe(1)
        } finally {
          releaseResponse?.()
          await page.unroute("**/session/*/tool/respond", respondRoute)
        }
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

test("todo updates stay out of the composer dock", async ({ page, llm, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e todo status-only active",
    async (session) => {
      await project.gotoSession(session.id)

      await llm.tool("todowrite", {
        todos: [{ content: "status-only active todo", status: "in_progress", priority: "medium" }],
      })
      await llm.text("todo started")
      await project.prompt("Create a todo and start it.")

      await expect(page.locator('[data-component="session-todo-dock"]')).toHaveCount(0)
      await expect(page.locator("#right-panel")).toHaveAttribute("aria-hidden", "true")
    },
    { trackSession: project.trackSession },
  )
})

test("todo updates do not switch an open right panel to status", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e todo does not switch right panel",
    async (session) => {
      await project.gotoSession(session.id)

      const rightPanel = await openRightPanel(page)
      await expect(rightPanel).toHaveAttribute("aria-hidden", "false")

      const shellTabList = rightPanelTabList(page)
      await shellTabList.getByRole("button", { name: "Add tab" }).click()
      await page.getByRole("menuitem", { name: "Files" }).click()
      const filesTab = shellTabList.getByRole("tab", { name: "Files", exact: true })
      await expect(filesTab).toHaveAttribute("aria-selected", "true")

      await e2eUpdateTodos(
        { url: project.url, directory: project.directory, sdk: project.sdk },
        {
          sessionID: session.id,
          todos: [{ content: "right panel stays on files", status: "in_progress", priority: "medium" }],
        },
      )

      await expect(page.locator('[data-component="session-todo-dock"]')).toHaveCount(0)
      await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
      await expect(filesTab).toHaveAttribute("aria-selected", "true")
    },
    { trackSession: project.trackSession },
  )
})

test("todo updates remain visible in the status panel", async ({ page, project }) => {
  await project.open()
  await withDockSession(
    project.sdk,
    "e2e todo status-only rows",
    async (session) => {
      const content = "status-only todo row"
      await project.gotoSession(session.id)

      await e2eUpdateTodos(
        { url: project.url, directory: project.directory, sdk: project.sdk },
        {
          sessionID: session.id,
          todos: [{ content, status: "in_progress", priority: "medium" }],
        },
      )

      const rightPanel = await openRightPanel(page)
      await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
      const statusTab = rightPanelTabList(page).getByRole("tab", { name: "Status", exact: true })
      await statusTab.click()
      await expect(statusTab).toHaveAttribute("aria-selected", "true")

      const summaryTodo = rightPanel.locator('[data-slot="status-summary-todo"]').filter({ hasText: content }).first()
      await expect(summaryTodo).toHaveAttribute("data-state", "in_progress", { timeout: 10_000 })

      await e2eUpdateTodos(
        { url: project.url, directory: project.directory, sdk: project.sdk },
        {
          sessionID: session.id,
          todos: [{ content, status: "completed", priority: "medium" }],
        },
      )

      await expect(summaryTodo).toHaveAttribute("data-state", "completed", { timeout: 10_000 })
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
        description:
          index === 0
            ? `Long option ${index + 1} description that fills the row. ${"This extra explanation keeps going so the option description itself must scroll instead of making the whole dock too tall. ".repeat(10)}`
            : `Long option ${index + 1} description that fills the row.`,
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

        const firstDescription = page.locator(`${questionDockSelector} [data-slot="option-description"]`).first()
        const descriptionMetrics = await firstDescription.evaluate((el) => {
          const target = el as HTMLElement
          return { clientHeight: target.clientHeight, scrollHeight: target.scrollHeight }
        })
        expect(descriptionMetrics.clientHeight).toBeLessThan(descriptionMetrics.scrollHeight)

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
