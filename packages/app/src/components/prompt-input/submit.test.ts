import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as uiToast from "@opencode-ai/ui/toast"
import type { Prompt } from "@/context/prompt"
import type { createPromptSubmit as createPromptSubmitType } from "./submit"
import { _portableDraftTesting } from "./portable-draft"
import { _pinnedDraftTesting, usePinnedDraft } from "./pinned-draft"

type PromptSubmitInput = Parameters<typeof createPromptSubmitType>[0]
type PromptSubmit = ReturnType<typeof createPromptSubmitType>

let createPromptSubmit: (input: PromptSubmitInput) => PromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: string[] = []
const syncedDirectories: string[] = []
const promptAsyncCalls: Array<Record<string, unknown>> = []
const commandCalls: Array<Record<string, unknown>> = []
const commandDefinitions: Array<{ name: string }> = []
let commandsReady = true
let promptAsyncFailure: Error | undefined
let promptAsyncGate: Promise<void> | undefined
let sessionCreateGate: Promise<void> | undefined
const abortedSessions: Array<{ sessionID: string; source?: string }> = []
const globalTodoSets: Array<{ sessionID: string; todos: unknown }> = []
const childTodoSets: Array<{ directory: string; sessionID: string; todos: unknown }> = []
const promptSetCalls: Array<{ prompt: Prompt; cursor?: number; target?: { dir: string; id?: string } }> = []
const promptResetCalls: Array<{ target?: { dir: string; id?: string } }> = []
const promptContextReplaceAllCalls: Array<{ items: unknown[]; target?: { dir: string; id?: string } }> = []
const promptHasDraftCalls: Array<{ target?: { dir: string; id?: string } }> = []
const uiSetModeCalls: Array<"normal" | "shell"> = []
const uiSetPopoverCalls: Array<"at" | "slash" | null> = []
const uiQueueScrollCalls: string[] = []
const uiFocusCalls: string[] = []
let promptContextItems: Array<{ key: string; type: "file"; path: string; comment?: string }> = []

let params: { dir?: string; id?: string } = {}
let navigateImpl = (_path: string): void => {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let promptDirty = false
let promptHasDraft = false

let currentIntl = "zh-Hans"
let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]

const waitForCall = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return
    await Promise.resolve()
  }
  throw new Error("timed out waiting for async request")
}

const waitForAsyncSubmitSettled = () => new Promise((resolve) => setTimeout(resolve, 0))

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    session: {
      create: async () => {
        createdSessions.push(directory)
        await sessionCreateGate
        return {
          data: {
            id: `session-${createdSessions.length}`,
            title: `New session ${createdSessions.length}`,
          },
        }
      },
      shell: async () => {
        sentShell.push(directory)
        return { data: undefined }
      },
      prompt: async () => ({ data: undefined }),
      promptAsync: async (input: Record<string, unknown>) => {
        promptAsyncCalls.push(input)
        await promptAsyncGate
        if (promptAsyncFailure) throw promptAsyncFailure
        return { data: undefined }
      },
      command: async (input: Record<string, unknown>) => {
        commandCalls.push(input)
        return { data: undefined }
      },
      abort: async (input: { sessionID: string; source?: string }) => {
        abortedSessions.push({ sessionID: input.sessionID, source: input.source })
        return { data: true }
      },
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => (path: string) => navigateImpl(path),
    useParams: () => params,
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  // spyOn + afterAll restore instead of mock.module: bun's mock.module is a
  // global, persistent, non-restoring registry override, so a noop toast mock
  // here leaked into every later test file in the run and broke suites that
  // rely on the real showToast (e.g. pawwork-session-commands.test.ts).
  spyOn(uiToast, "showToast").mockImplementation(() => 0)

  mock.module("@opencode-ai/util/encode", () => ({
    base64Encode: (value: string) => value,
    checksum: (value: string) => String(value.length),
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ sessionID, directory })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => ({
      current: () => promptValue,
      dirty: () => promptDirty,
      hasDraft: (target?: { dir: string; id?: string }) => {
        promptHasDraftCalls.push({ target })
        const targetIsActive = target && params.dir === target.dir && params.id === target.id
        return promptHasDraft || (!!targetIsActive && (promptDirty || promptContextItems.length > 0))
      },
      reset: (target?: { dir: string; id?: string }) => {
        promptResetCalls.push({ target })
      },
      set: (next: Prompt, cursor?: number, target?: { dir: string; id?: string }) => {
        promptSetCalls.push({ prompt: next, cursor, target })
      },
      context: {
        add: () => undefined,
        remove: () => undefined,
        items: () => promptContextItems,
        replaceAll: (items: unknown[], target?: { dir: string; id?: string }) => {
          promptContextReplaceAllCalls.push({ items, target })
        },
      },
    }),
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        directory: "/repo/main",
        client: rootClient,
        url: "http://localhost:4096",
        createClient(opts: { directory: string }) {
          return clientFor(opts.directory)
        },
      }
      return sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data: { command: commandDefinitions, get command_ready() { return commandsReady } },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/global-sync", () => ({
    useGlobalSync: () => ({
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] === "todo") {
              childTodoSets.push({ directory, sessionID: String(args[1]), todos: args[2] })
              return
            }
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
      todo: {
        set(sessionID: string, todos: unknown) {
          globalTodoSets.push({ sessionID, todos })
        },
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
      intl: () => currentIntl,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

afterAll(() => {
  mock.restore()
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promptAsyncCalls.length = 0
  commandCalls.length = 0
  commandDefinitions.length = 0
  commandsReady = true
  promptAsyncFailure = undefined
  promptAsyncGate = undefined
  sessionCreateGate = undefined
  abortedSessions.length = 0
  globalTodoSets.length = 0
  childTodoSets.length = 0
  promptSetCalls.length = 0
  promptResetCalls.length = 0
  promptContextReplaceAllCalls.length = 0
  promptHasDraftCalls.length = 0
  uiSetModeCalls.length = 0
  uiSetPopoverCalls.length = 0
  uiQueueScrollCalls.length = 0
  uiFocusCalls.length = 0
  promptContextItems = []
  params = {}
  navigateImpl = (_path: string): void => {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  promptDirty = false
  promptHasDraft = false
  currentIntl = "zh-Hans"
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  _portableDraftTesting.reset()
  _pinnedDraftTesting.reset()
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit worktree selection", () => {
  test("keeps cached todos when aborting the visible session", async () => {
    params = { id: "session-route" }
    const aborts: string[] = []
    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      sessionID: () => "session-visible",
      isNewSession: () => false,
      info: () => ({ id: "session-visible" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) =>
        value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onAbort: () => aborts.push("called"),
    })

    await submit.abort()

    expect(aborts).toEqual(["called"])
    expect(abortedSessions).toEqual([{ sessionID: "session-visible", source: "renderer.stopButton" }])
    expect(globalTodoSets).toEqual([])
    expect(childTodoSets).toEqual([])
  })

  test("does not abort or submit while session actions are not ready", async () => {
    params = { id: "session-visible" }
    const aborts: string[] = []
    const submits: string[] = []
    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      sessionID: () => "session-visible",
      isNewSession: () => false,
      info: () => ({ id: "session-visible" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      actionReady: () => false,
      abortReady: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => submits.push("history"),
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onAbort: () => aborts.push("called"),
      onSubmit: () => submits.push("submit"),
    })

    await submit.abort()
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(aborts).toEqual([])
    expect(submits).toEqual([])
    expect(abortedSessions).toEqual([])
    expect(promptAsyncCalls).toEqual([])
  })

  test("blocks normal slash submit until commands hydrate", async () => {
    params = { id: "session-existing" }
    commandsReady = false
    commandDefinitions.push({ name: "summarize" })
    promptValue = [{ type: "text", content: "/summarize this", start: 0, end: 15 }]
    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      sessionID: () => "session-existing",
      isNewSession: () => false,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(commandCalls).toEqual([])
    expect(promptAsyncCalls).toEqual([])
  })

  test("does not block shell absolute paths on command hydration", async () => {
    params = { id: "session-existing" }
    commandsReady = false
    promptValue = [{ type: "text", content: "/bin/ls", start: 0, end: 7 }]
    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      sessionID: () => "session-existing",
      isNewSession: () => false,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentShell).toEqual(["/repo/main"])
  })

  test("allows abort while submit readiness is blocked", async () => {
    params = { id: "session-visible" }
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
    const aborts: string[] = []
    const submits: string[] = []
    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      sessionID: () => "session-visible",
      isNewSession: () => false,
      info: () => ({ id: "session-visible" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      actionReady: () => false,
      abortReady: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => submits.push("history"),
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onAbort: () => aborts.push("called"),
      onSubmit: () => submits.push("submit"),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(aborts).toEqual(["called"])
    expect(abortedSessions).toEqual([{ sessionID: "session-visible", source: "renderer.stopButton" }])
    expect(submits).toEqual([])
    expect(promptAsyncCalls).toEqual([])
  })

  test("marks keyboard empty-enter abort with caller source", async () => {
    params = { id: "session-visible" }
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      sessionID: () => "session-visible",
      isNewSession: () => false,
      info: () => ({ id: "session-visible" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) =>
        value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit(new KeyboardEvent("keydown", { key: "Enter" }))

    expect(abortedSessions).toEqual([{ sessionID: "session-visible", source: "renderer.emptyEnter" }])
  })

  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
  })

  test("submits to the provided visible session instead of the route session", async () => {
    params = { id: "session-route" }

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      sessionID: () => "session-visible",
      isNewSession: () => false,
      info: () => ({ id: "session-visible" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptAsyncCalls.length > 0)

    expect(promptAsyncCalls.at(-1)?.sessionID).toBe("session-visible")
    expect(optimistic.at(-1)?.sessionID).toBe("session-visible")
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toEqual([{ id: "session-1", title: "New session 1" }])
    expect(optimisticSeeded).toEqual([true])
  })

  test("new worktree submit rollback targets final prompt route scope", async () => {
    params = { dir: "/repo/main" }
    selected = "/repo/worktree-a"
    promptValue = [{ type: "text", content: "run tests", start: 0, end: 9 }]
    promptAsyncFailure = new Error("send failed")
    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptSetCalls.length > 0)

    expect(promptSetCalls.at(-1)?.target).toEqual({ dir: "/repo/worktree-a", id: "session-1" })
  })

  test("sends locale with promptAsync requests", async () => {
    params = { id: "session-existing" }
    currentIntl = "pt-BR"

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptAsyncCalls.length > 0)

    expect(promptAsyncCalls.at(-1)?.locale).toBe("pt-BR")
  })

  test("allows attachment-only promptAsync submits", async () => {
    params = { id: "session-existing" }
    promptValue = [{ type: "file", path: "guide.pdf", content: "@guide.pdf", start: 0, end: 10 }]

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptAsyncCalls.length > 0)

    const parts = promptAsyncCalls.at(-1)?.parts as Array<Record<string, unknown>>
    expect(parts.some((part) => part.type === "file" && part.url === "file:///repo/main/guide.pdf")).toBe(true)
  })

  test("allows chip-only promptAsync submits", async () => {
    params = { id: "session-existing" }
    promptValue = [
      { type: "text", content: "", start: 0, end: 0 },
      { type: "attachment", id: "att_1", path: "/Users/me/shot.png", filename: "shot.png", mime: "image/png" },
    ]

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptAsyncCalls.length > 0)

    const parts = promptAsyncCalls.at(-1)?.parts as Array<Record<string, unknown>>
    expect(parts.some((part) => part.type === "file" && part.url === "file:///Users/me/shot.png")).toBe(true)
  })

  test("queues locale on followup drafts", async () => {
    params = { id: "session-existing" }
    const queued: Array<Record<string, unknown>> = []

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => true,
      onQueue: (draft) => queued.push(draft as unknown as Record<string, unknown>),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(queued.at(-1)?.locale).toBe("zh-Hans")
  })

  test("sends locale with direct slash-command submits", async () => {
    params = { id: "session-existing" }
    currentIntl = "nb-NO"
    commandDefinitions.push({ name: "summarize" })
    promptValue = [{ type: "text", content: "/summarize this", start: 0, end: 15 }]

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => commandCalls.length > 0)

    expect(commandCalls.at(-1)?.locale).toBe("nb-NO")
  })

  test("sends file attachment parts with direct slash-command submits", async () => {
    params = { id: "session-existing" }
    commandDefinitions.push({ name: "summarize" })
    promptValue = [
      { type: "text", content: "/summarize ", start: 0, end: 11 },
      { type: "file", path: "guide.pdf", content: "@guide.pdf", start: 11, end: 21 },
    ]

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => commandCalls.length > 0)

    expect(commandCalls.at(-1)?.parts).toEqual([
      {
        id: expect.any(String),
        type: "file",
        mime: "text/plain",
        url: "file:///repo/main/guide.pdf",
        filename: "guide.pdf",
        source: {
          type: "file",
          text: { value: "@guide.pdf", start: 11, end: 21 },
          path: "/repo/main/guide.pdf",
        },
      },
    ])
  })

  test("clears prompt source scope on successful new-session submit", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "hello", start: 0, end: 5 }]
    // Simulate navigate() changing params.id to the new session id, just as SolidJS router does
    navigateImpl = (path: string) => {
      const match = path.match(/\/session\/([^/]+)/)
      if (match) params.id = match[1]
    }

    const submit = createHomepageSubmit()

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptResetCalls.length > 0)

    // After navigate(), params.id is now "session-1", but clearInput must reset the
    // SOURCE scope (home page: dir=/repo/main, no session id) not the final session scope
    expect(params.id).toBe("session-1") // confirm navigate ran and updated params
    expect(promptResetCalls.at(-1)?.target?.dir).toBe("/repo/main")
    expect(promptResetCalls.at(-1)?.target?.id).toBeUndefined()
  })

  test("does not clear homepage global draft if it changed before new-session clear", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "old draft", start: 0, end: 9 }]
    let releaseSessionCreate!: () => void
    sessionCreateGate = new Promise<void>((resolve) => {
      releaseSessionCreate = resolve
    })

    const submit = createHomepageSubmit()

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => createdSessions.length > 0)

    promptValue = [{ type: "text", content: "new draft", start: 0, end: 9 }]
    releaseSessionCreate()
    await submitted
    await waitForAsyncSubmitSettled()

    expect(promptResetCalls).toEqual([])
  })

  const createHomepageSubmit = (overrides: Partial<PromptSubmitInput> = {}) =>
    createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => uiQueueScrollCalls.push("queue"),
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: (nextMode) => uiSetModeCalls.push(nextMode),
      setPopover: (popover) => uiSetPopoverCalls.push(popover),
      onSubmit: () => undefined,
      ...overrides,
    })

  test("clears submitted global homepage draft before async prompt settles", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "already sent", start: 0, end: 12 }]

    let releasePromptAsync!: () => void
    promptAsyncGate = new Promise<void>((resolve) => {
      releasePromptAsync = resolve
    })

    const submit = createHomepageSubmit()

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptResetCalls.length > 0)

    expect(promptResetCalls.at(-1)?.target).toEqual({ dir: "/repo/main", id: undefined })

    releasePromptAsync()
    await submitted
  })

  test("restores submitted global homepage draft on async prompt failure when no new draft exists", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "restore me", start: 0, end: 10 }]
    promptAsyncFailure = new Error("network down")

    const submit = createHomepageSubmit()

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptSetCalls.length > 0)

    expect(promptSetCalls.at(-1)).toMatchObject({
      prompt: promptValue,
      cursor: 10,
      target: { dir: "/repo/main", id: "session-1" },
    })
  })

  test("restores submitted global homepage draft when a different active route is dirty", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "background fail", start: 0, end: 15 }]

    let releasePromptAsync!: () => void
    promptAsyncGate = new Promise<void>((resolve) => {
      releasePromptAsync = resolve
    })
    promptAsyncFailure = new Error("network down")

    const submit = createHomepageSubmit()

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptAsyncCalls.length > 0)

    params = { dir: "/repo/other", id: "session-other" }
    promptDirty = true
    releasePromptAsync()
    await submitted
    await waitForCall(() => promptSetCalls.length > 0)

    expect(promptSetCalls.at(-1)).toMatchObject({
      prompt: promptValue,
      cursor: 15,
      target: { dir: "/repo/main", id: "session-1" },
    })
  })

  test("restores submitted global homepage draft in background without changing active composer UI", async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0)
      return 0
    }) as typeof requestAnimationFrame
    try {
      params = { dir: "/repo/main" }
      promptValue = [{ type: "text", content: "background ui", start: 0, end: 13 }]

      const editor = document.createElement("div")
      editor.textContent = "active composer"
      Object.defineProperty(editor, "focus", { value: () => uiFocusCalls.push("focus") })

      let releasePromptAsync!: () => void
      promptAsyncGate = new Promise<void>((resolve) => {
        releasePromptAsync = resolve
      })
      promptAsyncFailure = new Error("network down")

      const submit = createHomepageSubmit({ editor: () => editor })

      const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
      await waitForCall(() => promptResetCalls.length > 0)
      const modeCallsAfterClear = uiSetModeCalls.length
      const popoverCallsAfterClear = uiSetPopoverCalls.length
      const focusCallsAfterClear = uiFocusCalls.length
      const queueScrollCallsAfterClear = uiQueueScrollCalls.length

      params = { dir: "/repo/other", id: "session-other" }
      releasePromptAsync()
      await submitted
      await waitForAsyncSubmitSettled()

      expect(promptSetCalls.at(-1)).toMatchObject({
        prompt: promptValue,
        cursor: 13,
        target: { dir: "/repo/main", id: "session-1" },
      })
      expect(uiSetModeCalls).toHaveLength(modeCallsAfterClear)
      expect(uiSetPopoverCalls).toHaveLength(popoverCallsAfterClear)
      expect(uiFocusCalls).toHaveLength(focusCallsAfterClear)
      expect(uiQueueScrollCalls).toHaveLength(queueScrollCallsAfterClear)
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
    }
  })

  test("restores submitted global homepage context to target scope when a different active route is dirty", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "background context", start: 0, end: 18 }]
    const submittedContext = [{ key: "old", type: "file" as const, path: "/repo/main/old.ts", comment: "old note" }]
    promptContextItems = submittedContext

    let releasePromptAsync!: () => void
    promptAsyncGate = new Promise<void>((resolve) => {
      releasePromptAsync = resolve
    })
    promptAsyncFailure = new Error("network down")

    const submit = createHomepageSubmit()

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptAsyncCalls.length > 0)

    params = { dir: "/repo/other", id: "session-other" }
    promptDirty = true
    releasePromptAsync()
    await submitted
    await waitForCall(() => promptContextReplaceAllCalls.length > 0)

    expect(promptSetCalls.at(-1)?.target).toEqual({ dir: "/repo/main", id: "session-1" })
    expect(promptContextReplaceAllCalls.at(-1)).toEqual({
      items: [{ type: "file", path: "/repo/main/old.ts", comment: "old note" }],
      target: { dir: "/repo/main", id: "session-1" },
    })
  })

  test("does not restore submitted global homepage draft over dirty active target route", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "same route fail", start: 0, end: 15 }]

    let releasePromptAsync!: () => void
    promptAsyncGate = new Promise<void>((resolve) => {
      releasePromptAsync = resolve
    })
    promptAsyncFailure = new Error("network down")

    const submit = createHomepageSubmit()

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptAsyncCalls.length > 0)

    params = { dir: "/repo/main", id: "session-1" }
    promptDirty = true
    releasePromptAsync()
    await submitted
    await Promise.resolve()
    await Promise.resolve()

    expect(promptSetCalls).toEqual([])
  })

  test("does not restore submitted global homepage draft over context-only active target route", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "same route context", start: 0, end: 18 }]

    let releasePromptAsync!: () => void
    promptAsyncGate = new Promise<void>((resolve) => {
      releasePromptAsync = resolve
    })
    promptAsyncFailure = new Error("network down")

    const submit = createHomepageSubmit()

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptAsyncCalls.length > 0)

    params = { dir: "/repo/main", id: "session-1" }
    promptDirty = false
    promptContextItems = [{ key: "new", type: "file", path: "/repo/main/new.ts", comment: "new note" }]
    releasePromptAsync()
    await submitted
    await waitForAsyncSubmitSettled()

    expect(promptSetCalls).toEqual([])
    expect(promptContextReplaceAllCalls).toEqual([])
    expect(promptHasDraftCalls.at(-1)?.target).toEqual({ dir: "/repo/main", id: "session-1" })
  })

  test("does not restore submitted global homepage draft over inactive target route with a newer draft", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "old submit", start: 0, end: 10 }]

    let releasePromptAsync!: () => void
    promptAsyncGate = new Promise<void>((resolve) => {
      releasePromptAsync = resolve
    })
    promptAsyncFailure = new Error("network down")

    const submit = createHomepageSubmit()

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptAsyncCalls.length > 0)

    params = { dir: "/repo/main", id: "session-1" }
    promptHasDraft = true
    params = { dir: "/repo/other", id: "session-other" }
    releasePromptAsync()
    await submitted
    await waitForAsyncSubmitSettled()

    expect(promptSetCalls).toEqual([])
    expect(promptContextReplaceAllCalls).toEqual([])
    expect(promptHasDraftCalls.at(-1)?.target).toEqual({ dir: "/repo/main", id: "session-1" })
  })

  test("detaches submitted pinned draft before async prompt settles", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "deep link", start: 0, end: 9 }]
    const pinned = usePinnedDraft()
    pinned.adopt({ directory: "/repo/main", prompt: "deep link" })

    let releasePromptAsync!: () => void
    promptAsyncGate = new Promise<void>((resolve) => {
      releasePromptAsync = resolve
    })

    const submit = createHomepageSubmit()

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptResetCalls.length > 0)

    expect(pinned.current()).toBeNull()

    releasePromptAsync()
    await submitted
  })

  test("restores submitted pinned draft on async prompt failure when no new draft exists", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "restore pin", start: 0, end: 11 }]
    promptContextItems = [{ key: "pin", type: "file", path: "/repo/main/pin.ts", comment: "pin note" }]
    const pinned = usePinnedDraft()
    pinned.adopt({ directory: "/repo/main", prompt: "restore pin" })
    promptAsyncFailure = new Error("network down")

    const submit = createHomepageSubmit()

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptSetCalls.length > 0)

    expect(pinned.current()).toBeNull()
    expect(promptSetCalls.at(-1)).toMatchObject({
      prompt: promptValue,
      cursor: 11,
      target: { dir: "/repo/main", id: "session-1" },
    })
  })

  test("restores submitted pinned context to target scope when a different active route is dirty", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "restore pin", start: 0, end: 11 }]
    promptContextItems = [{ key: "pin", type: "file", path: "/repo/main/pin.ts", comment: "pin note" }]
    const pinned = usePinnedDraft()
    pinned.adopt({ directory: "/repo/main", prompt: "restore pin" })
    pinned.recordEdit({
      directory: "/repo/main",
      prompt: promptValue,
      context: promptContextItems,
      images: [],
      resolvedMentions: {},
    })

    let releasePromptAsync!: () => void
    promptAsyncGate = new Promise<void>((resolve) => {
      releasePromptAsync = resolve
    })
    promptAsyncFailure = new Error("network down")

    const submit = createHomepageSubmit()

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptAsyncCalls.length > 0)

    params = { dir: "/repo/other", id: "session-other" }
    promptDirty = true
    releasePromptAsync()
    await submitted
    await waitForCall(() => promptContextReplaceAllCalls.length > 0)

    expect(promptSetCalls.at(-1)?.target).toEqual({ dir: "/repo/main", id: "session-1" })
    expect(promptContextReplaceAllCalls.at(-1)).toEqual({
      items: [{ type: "file", path: "/repo/main/pin.ts", comment: "pin note" }],
      target: { dir: "/repo/main", id: "session-1" },
    })
  })

  test("restores submitted pinned draft while preserving a different homepage owner draft", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "old pin", start: 0, end: 7 }]
    const pinned = usePinnedDraft()
    pinned.adopt({ directory: "/repo/main", prompt: "old pin" })

    let releasePromptAsync!: () => void
    promptAsyncGate = new Promise<void>((resolve) => {
      releasePromptAsync = resolve
    })
    promptAsyncFailure = new Error("network down")

    const submit = createHomepageSubmit()

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptResetCalls.length > 0)

    params = { dir: "/repo/other" }
    pinned.adopt({ directory: "/repo/other", prompt: "new pin" })
    releasePromptAsync()
    await submitted
    await waitForAsyncSubmitSettled()

    expect(promptSetCalls.at(-1)).toMatchObject({
      prompt: promptValue,
      cursor: 7,
      target: { dir: "/repo/main", id: "session-1" },
    })
    expect(pinned.current()).toMatchObject({
      directory: "/repo/other",
      prompt: [{ type: "text", content: "new pin", start: 0, end: 7 }],
    })
  })

  test("restores submitted pinned draft in background without changing active composer UI", async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0)
      return 0
    }) as typeof requestAnimationFrame
    try {
      params = { dir: "/repo/main" }
      promptValue = [{ type: "text", content: "pin background", start: 0, end: 14 }]
      const pinned = usePinnedDraft()
      pinned.adopt({ directory: "/repo/main", prompt: "pin background" })

      const editor = document.createElement("div")
      editor.textContent = "active composer"
      Object.defineProperty(editor, "focus", { value: () => uiFocusCalls.push("focus") })

      let releasePromptAsync!: () => void
      promptAsyncGate = new Promise<void>((resolve) => {
        releasePromptAsync = resolve
      })
      promptAsyncFailure = new Error("network down")

      const submit = createHomepageSubmit({ editor: () => editor })

      const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
      await waitForCall(() => promptResetCalls.length > 0)
      const modeCallsAfterClear = uiSetModeCalls.length
      const popoverCallsAfterClear = uiSetPopoverCalls.length
      const focusCallsAfterClear = uiFocusCalls.length
      const queueScrollCallsAfterClear = uiQueueScrollCalls.length

      params = { dir: "/repo/other", id: "session-other" }
      releasePromptAsync()
      await submitted
      await waitForAsyncSubmitSettled()

      expect(promptSetCalls.at(-1)).toMatchObject({
        prompt: promptValue,
        cursor: 14,
        target: { dir: "/repo/main", id: "session-1" },
      })
      expect(uiSetModeCalls).toHaveLength(modeCallsAfterClear)
      expect(uiSetPopoverCalls).toHaveLength(popoverCallsAfterClear)
      expect(uiFocusCalls).toHaveLength(focusCallsAfterClear)
      expect(uiQueueScrollCalls).toHaveLength(queueScrollCallsAfterClear)
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
    }
  })

  test("does not restore submitted pinned draft over context-only active target route", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "old pin", start: 0, end: 7 }]
    const pinned = usePinnedDraft()
    pinned.adopt({ directory: "/repo/main", prompt: "old pin" })

    let releasePromptAsync!: () => void
    promptAsyncGate = new Promise<void>((resolve) => {
      releasePromptAsync = resolve
    })
    promptAsyncFailure = new Error("network down")

    const submit = createHomepageSubmit()

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptAsyncCalls.length > 0)

    params = { dir: "/repo/main", id: "session-1" }
    promptDirty = false
    promptContextItems = [{ key: "new", type: "file", path: "/repo/main/new-pin.ts", comment: "new pin note" }]
    releasePromptAsync()
    await submitted
    await Promise.resolve()
    await Promise.resolve()

    expect(promptSetCalls).toEqual([])
    expect(promptContextReplaceAllCalls).toEqual([])
  })

  test("does not restore submitted pinned draft over inactive target route with a newer draft", async () => {
    params = { dir: "/repo/main" }
    promptValue = [{ type: "text", content: "old pin", start: 0, end: 7 }]
    const pinned = usePinnedDraft()
    pinned.adopt({ directory: "/repo/main", prompt: "old pin" })

    let releasePromptAsync!: () => void
    promptAsyncGate = new Promise<void>((resolve) => {
      releasePromptAsync = resolve
    })
    promptAsyncFailure = new Error("network down")

    const submit = createHomepageSubmit()

    const submitted = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => promptAsyncCalls.length > 0)

    params = { dir: "/repo/main", id: "session-1" }
    promptHasDraft = true
    params = { dir: "/repo/other", id: "session-other" }
    releasePromptAsync()
    await submitted
    await waitForAsyncSubmitSettled()

    expect(promptSetCalls).toEqual([])
    expect(promptContextReplaceAllCalls).toEqual([])
    expect(promptHasDraftCalls.at(-1)?.target).toEqual({ dir: "/repo/main", id: "session-1" })
  })
})

describe("Path D — marked TextPart routes through session.command", () => {
  test("marked('/brainstorming ') alone → command call with arguments ''", async () => {
    params = { id: "session-existing" }
    commandDefinitions.push({ name: "brainstorming" })
    promptValue = [{
      type: "text", content: "/brainstorming ", start: 0, end: 15,
      command: { name: "brainstorming", source: "skill", icon: "command" },
    }]

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => commandCalls.length > 0)

    expect(commandCalls.at(-1)?.command).toBe("brainstorming")
    expect(commandCalls.at(-1)?.arguments).toBe("")
  })

  test("marked + FilePart args projection → args includes file content", async () => {
    params = { id: "session-existing" }
    commandDefinitions.push({ name: "brainstorming" })
    promptValue = [
      { type: "text", content: "/brainstorming ", start: 0, end: 15,
        command: { name: "brainstorming", source: "skill", icon: "command" } },
      { type: "file", path: "foo.ts", content: "@foo.ts", start: 15, end: 22 } as any,
    ]

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => commandCalls.length > 0)

    expect(commandCalls.at(-1)?.command).toBe("brainstorming")
    expect(commandCalls.at(-1)?.arguments).toBe("@foo.ts")
  })

  test("invariant-violated marked TextPart falls through to plain-prompt path", async () => {
    params = { id: "session-existing" }
    commandDefinitions.push({ name: "brainstorming" })
    const before = commandCalls.length
    // content does NOT start with /<name> — invariant breach
    promptValue = [{
      type: "text", content: "WRONG", start: 0, end: 5,
      command: { name: "brainstorming", source: "skill", icon: "command" },
    }]

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    // Invariant breach + content not starting with /<name> → falls through.
    // The legacy fallback also won't fire (text "WRONG" doesn't start with /).
    // So no NEW command call is made.
    expect(commandCalls.length).toBe(before)
  })
})

describe("Legacy fallback boundary (no marked TextPart)", () => {
  test("[Text('/brainstorming'), File('@foo.ts')] → NOT a command (no separator space)", async () => {
    params = { id: "session-existing" }
    commandDefinitions.push({ name: "brainstorming" })
    const before = commandCalls.length
    promptValue = [
      { type: "text", content: "/brainstorming", start: 0, end: 14 },
      { type: "file", path: "foo.ts", content: "@foo.ts", start: 14, end: 21 } as any,
    ]

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    // flatText = "/brainstorming@foo.ts", head split-by-space = "/brainstorming@foo.ts",
    // slice(1) = "brainstorming@foo.ts", registry miss → submits as plain prompt.
    expect(commandCalls.length).toBe(before)
  })

  test("[Text('/brainstorming '), File('@foo.ts')] → command, args '@foo.ts'", async () => {
    params = { id: "session-existing" }
    commandDefinitions.push({ name: "brainstorming" })
    promptValue = [
      { type: "text", content: "/brainstorming ", start: 0, end: 15 },
      { type: "file", path: "foo.ts", content: "@foo.ts", start: 15, end: 22 } as any,
    ]

    const submit = createPromptSubmit({
      navigate: (path) => navigateImpl(path),
      routeParams: () => params,
      info: () => ({ id: "session-existing" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await waitForCall(() => commandCalls.length > 0)

    expect(commandCalls.at(-1)?.command).toBe("brainstorming")
    expect(commandCalls.at(-1)?.arguments).toBe("@foo.ts")
  })
})
