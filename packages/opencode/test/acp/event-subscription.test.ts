import { describe, expect, test } from "bun:test"
import { ACP } from "../../src/acp/agent"
import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type {
  Event,
  EventMessagePartUpdated,
  FilePart,
  ToolStateCompleted,
  ToolStatePending,
  ToolStateRunning,
} from "@opencode-ai/sdk/v2"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
type RequestPermissionParams = Parameters<AgentSideConnection["requestPermission"]>[0]
type RequestPermissionResult = Awaited<ReturnType<AgentSideConnection["requestPermission"]>>

type GlobalEventEnvelope = {
  directory?: string
  payload?: Event
}

type EventController = {
  push: (event: GlobalEventEnvelope) => void
  close: () => void
}

function inProgressText(update: SessionUpdateParams["update"]) {
  if (update.sessionUpdate !== "tool_call_update") return undefined
  if (update.status !== "in_progress") return undefined
  if (!update.content || !Array.isArray(update.content)) return undefined
  const first = update.content[0]
  if (!first || first.type !== "content") return undefined
  if (first.content.type !== "text") return undefined
  return first.content.text
}

function isToolCallUpdate(
  update: SessionUpdateParams["update"],
): update is Extract<SessionUpdateParams["update"], { sessionUpdate: "tool_call_update" }> {
  return update.sessionUpdate === "tool_call_update"
}

function isToolCall(
  update: SessionUpdateParams["update"],
): update is Extract<SessionUpdateParams["update"], { sessionUpdate: "tool_call" }> {
  return update.sessionUpdate === "tool_call"
}

function toolEvent(
  sessionId: string,
  cwd: string,
  opts: {
    callID: string
    tool: string
    input: Record<string, unknown>
  } & (
    | { status: "running"; metadata?: Record<string, unknown> }
    | { status: "pending"; raw: string }
    | { status: "completed"; output: string; metadata?: Record<string, unknown>; title?: string; attachments?: FilePart[] }
  ),
): GlobalEventEnvelope {
  const state: ToolStatePending | ToolStateRunning | ToolStateCompleted =
    opts.status === "running"
      ? {
          status: "running",
          input: opts.input,
          ...(opts.metadata && { metadata: opts.metadata }),
          time: { start: Date.now() },
        }
      : opts.status === "completed"
        ? {
            status: "completed",
            input: opts.input,
            output: opts.output,
            title: opts.title ?? "test",
            metadata: opts.metadata ?? {},
            ...(opts.attachments && { attachments: opts.attachments }),
            time: { start: Date.now(), end: Date.now() },
          }
        : {
            status: "pending",
            input: opts.input,
            raw: opts.raw,
          }
  const payload: EventMessagePartUpdated = {
    type: "message.part.updated",
    properties: {
      sessionID: sessionId,
      time: Date.now(),
      part: {
        id: `part_${opts.callID}`,
        sessionID: sessionId,
        messageID: `msg_${opts.callID}`,
        type: "tool",
        callID: opts.callID,
        tool: opts.tool,
        state,
      },
    },
  }
  return { directory: cwd, payload }
}

function createEventStream() {
  const queue: GlobalEventEnvelope[] = []
  const waiters: Array<(value: GlobalEventEnvelope | undefined) => void> = []
  const state = { closed: false }

  const push = (event: GlobalEventEnvelope) => {
    const waiter = waiters.shift()
    if (waiter) {
      waiter(event)
      return
    }
    queue.push(event)
  }

  const close = () => {
    state.closed = true
    for (const waiter of waiters.splice(0)) {
      waiter(undefined)
    }
  }

  const stream = async function* (signal?: AbortSignal) {
    while (true) {
      if (signal?.aborted) return
      const next = queue.shift()
      if (next) {
        yield next
        continue
      }
      if (state.closed) return
      const value = await new Promise<GlobalEventEnvelope | undefined>((resolve) => {
        waiters.push(resolve)
        if (!signal) return
        signal.addEventListener("abort", () => resolve(undefined), { once: true })
      })
      if (!value) return
      yield value
    }
  }

  return { controller: { push, close } satisfies EventController, stream }
}

function createFakeAgent() {
  const updates = new Map<string, string[]>()
  const chunks = new Map<string, string>()
  const sessionUpdates: SessionUpdateParams[] = []
  const permissionRequests: RequestPermissionParams[] = []
  const record = (sessionId: string, type: string) => {
    const list = updates.get(sessionId) ?? []
    list.push(type)
    updates.set(sessionId, list)
  }

  const connection = {
    async sessionUpdate(params: SessionUpdateParams) {
      sessionUpdates.push(params)
      const update = params.update
      const type = update?.sessionUpdate ?? "unknown"
      record(params.sessionId, type)
      if (update?.sessionUpdate === "agent_message_chunk") {
        const content = update.content
        if (content?.type !== "text") return
        if (typeof content.text !== "string") return
        chunks.set(params.sessionId, (chunks.get(params.sessionId) ?? "") + content.text)
      }
    },
    async requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult> {
      permissionRequests.push(params)
      return { outcome: { outcome: "selected", optionId: "once" } } as RequestPermissionResult
    },
  } as unknown as AgentSideConnection

  const { controller, stream } = createEventStream()
  const calls = {
    eventSubscribe: 0,
    sessionCreate: 0,
  }

  const sdk = {
    global: {
      event: async (opts?: { signal?: AbortSignal }) => {
        calls.eventSubscribe++
        return { stream: stream(opts?.signal) }
      },
    },
    session: {
      create: async (_params?: any) => {
        calls.sessionCreate++
        return {
          data: {
            id: `ses_${calls.sessionCreate}`,
            time: { created: new Date().toISOString() },
          },
        }
      },
      get: async (_params?: any) => {
        return {
          data: {
            id: "ses_1",
            time: { created: new Date().toISOString() },
          },
        }
      },
      messages: async () => {
        return { data: [] }
      },
      message: async (params?: any) => {
        // Return a message with parts that can be looked up by partID
        return {
          data: {
            info: {
              role: "assistant",
            },
            parts: [
              {
                id: params?.messageID ? `${params.messageID}_part` : "part_1",
                type: "text",
                text: "",
              },
            ],
          },
        }
      },
    },
    permission: {
      respond: async () => {
        return { data: true }
      },
    },
    config: {
      providers: async () => {
        return {
          data: {
            providers: [
              {
                id: "opencode",
                name: "opencode",
                models: {
                  "big-pickle": { id: "big-pickle", name: "big-pickle" },
                },
              },
            ],
          },
        }
      },
    },
    app: {
      agents: async () => {
        return {
          data: [
            {
              name: "build",
              description: "build",
              mode: "agent",
            },
          ],
        }
      },
    },
    command: {
      list: async () => {
        return { data: [] }
      },
    },
    mcp: {
      add: async () => {
        return { data: true }
      },
    },
  } as any

  const agent = new ACP.Agent(connection, {
    sdk,
    defaultModel: { providerID: "opencode", modelID: "big-pickle" },
  } as any)

  const stop = () => {
    controller.close()
    ;(agent as any).eventAbort.abort()
  }

  return { agent, controller, calls, updates, chunks, sessionUpdates, permissionRequests, stop, sdk, connection }
}

describe("acp.agent event subscription", () => {
  test("routes message.part.delta by the event sessionID (no cross-session pollution)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, updates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"

        const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const sessionB = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        controller.push({
          directory: cwd,
          payload: {
            type: "message.part.delta",
            properties: {
              sessionID: sessionB,
              messageID: "msg_1",
              partID: "msg_1_part",
              field: "text",
              delta: "hello",
            },
          },
        } as any)

        await new Promise((r) => setTimeout(r, 10))

        expect((updates.get(sessionA) ?? []).includes("agent_message_chunk")).toBe(false)
        expect((updates.get(sessionB) ?? []).includes("agent_message_chunk")).toBe(true)

        stop()
      },
    })
  })

  test("keeps concurrent sessions isolated when message.part.delta events are interleaved", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, chunks, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"

        const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const sessionB = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        const tokenA = ["ALPHA_", "111", "_X"]
        const tokenB = ["BETA_", "222", "_Y"]

        const push = (sessionId: string, messageID: string, delta: string) => {
          controller.push({
            directory: cwd,
            payload: {
              type: "message.part.delta",
              properties: {
                sessionID: sessionId,
                messageID,
                partID: `${messageID}_part`,
                field: "text",
                delta,
              },
            },
          } as any)
        }

        push(sessionA, "msg_a", tokenA[0])
        push(sessionB, "msg_b", tokenB[0])
        push(sessionA, "msg_a", tokenA[1])
        push(sessionB, "msg_b", tokenB[1])
        push(sessionA, "msg_a", tokenA[2])
        push(sessionB, "msg_b", tokenB[2])

        await new Promise((r) => setTimeout(r, 20))

        const a = chunks.get(sessionA) ?? ""
        const b = chunks.get(sessionB) ?? ""

        expect(a).toContain(tokenA.join(""))
        expect(b).toContain(tokenB.join(""))
        for (const part of tokenB) expect(a).not.toContain(part)
        for (const part of tokenA) expect(b).not.toContain(part)

        stop()
      },
    })
  })

  test("does not create additional event subscriptions on repeated loadSession()", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, calls, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"

        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)
        await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)
        await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)
        await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)

        expect(calls.eventSubscribe).toBe(1)

        stop()
      },
    })
  })

  test("permission.asked events are handled and replied", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const permissionReplies: string[] = []
        const { agent, controller, stop, sdk } = createFakeAgent()
        sdk.permission.reply = async (params: any) => {
          permissionReplies.push(params.requestID)
          return { data: true }
        }
        const cwd = "/tmp/opencode-acp-test"

        const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        controller.push({
          directory: cwd,
          payload: {
            type: "permission.asked",
            properties: {
              id: "perm_1",
              sessionID: sessionA,
              permission: "bash",
              patterns: ["*"],
              metadata: {},
              always: [],
            },
          },
        } as any)

        await new Promise((r) => setTimeout(r, 20))

        expect(permissionReplies).toContain("perm_1")

        stop()
      },
    })
  })

  test("permission.asked external_directory events include input and locations", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, permissionRequests, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const metadata = {
          command: "cat /var/log/app.log",
          description: "read external log",
          directories: ["/var/log"],
          patterns: ["/var/log/*"],
        }

        controller.push({
          directory: cwd,
          payload: {
            type: "permission.asked",
            properties: {
              id: "perm_external",
              sessionID: sessionId,
              permission: "external_directory",
              patterns: ["/var/log/*"],
              metadata,
              always: ["/var/log/*"],
            },
          },
        } as any)

        await new Promise((r) => setTimeout(r, 20))

        const request = permissionRequests.find((item) => item.sessionId === sessionId)
        expect(request?.toolCall.rawInput).toEqual(metadata)
        expect(request?.toolCall.locations).toEqual([{ path: "/var/log" }])
        stop()
      },
    })
  })

  test("permission.asked without always patterns omits the ACP always option", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, permissionRequests, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        controller.push({
          directory: cwd,
          payload: {
            type: "permission.asked",
            properties: {
              id: "perm_once_only",
              sessionID: sessionId,
              permission: "automate_manage",
              patterns: ["aut_123"],
              metadata: { action: "delete", id: "aut_123", title: "Daily repo brief" },
              always: [],
            },
          },
        } as any)

        await new Promise((r) => setTimeout(r, 20))

        const request = permissionRequests.find((item) => item.sessionId === sessionId)
        expect(request?.options.map((option) => option.optionId)).toEqual(["once", "reject"])
        stop()
      },
    })
  })

  test("permission.asked with always patterns includes the ACP always option", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, permissionRequests, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        controller.push({
          directory: cwd,
          payload: {
            type: "permission.asked",
            properties: {
              id: "perm_persistable",
              sessionID: sessionId,
              permission: "bash",
              patterns: ["echo ok"],
              metadata: {},
              always: ["echo ok"],
            },
          },
        } as any)

        await new Promise((r) => setTimeout(r, 20))

        const request = permissionRequests.find((item) => item.sessionId === sessionId)
        expect(request?.options.map((option) => option.optionId)).toEqual(["once", "always", "reject"])
        stop()
      },
    })
  })

  test("permission prompt on session A does not block message updates for session B", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const permissionReplies: string[] = []
        let resolvePermissionA: (() => void) | undefined
        const permissionABlocking = new Promise<void>((r) => {
          resolvePermissionA = r
        })

        const { agent, controller, chunks, stop, sdk, connection } = createFakeAgent()

        // Make permission request for session A block until we release it
        const originalRequestPermission = connection.requestPermission.bind(connection)
        let permissionCalls = 0
        connection.requestPermission = async (params: RequestPermissionParams) => {
          permissionCalls++
          if (params.sessionId.endsWith("1")) {
            await permissionABlocking
          }
          return originalRequestPermission(params)
        }

        sdk.permission.reply = async (params: any) => {
          permissionReplies.push(params.requestID)
          return { data: true }
        }

        const cwd = "/tmp/opencode-acp-test"

        const sessionA = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const sessionB = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        // Push permission.asked for session A (will block)
        controller.push({
          directory: cwd,
          payload: {
            type: "permission.asked",
            properties: {
              id: "perm_a",
              sessionID: sessionA,
              permission: "bash",
              patterns: ["*"],
              metadata: {},
              always: [],
            },
          },
        } as any)

        // Give time for permission handling to start
        await new Promise((r) => setTimeout(r, 10))

        // Push message for session B while A's permission is pending
        controller.push({
          directory: cwd,
          payload: {
            type: "message.part.delta",
            properties: {
              sessionID: sessionB,
              messageID: "msg_b",
              partID: "msg_b_part",
              field: "text",
              delta: "session_b_message",
            },
          },
        } as any)

        // Wait for session B's message to be processed
        await new Promise((r) => setTimeout(r, 20))

        // Session B should have received message even though A's permission is still pending
        expect(chunks.get(sessionB) ?? "").toContain("session_b_message")
        expect(permissionReplies).not.toContain("perm_a")

        // Release session A's permission
        resolvePermissionA!()
        await new Promise((r) => setTimeout(r, 20))

        // Now session A's permission should be replied
        expect(permissionReplies).toContain("perm_a")

        stop()
      },
    })
  })

  test("streams running bash output snapshots and de-dupes identical snapshots", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const input = { command: "echo hello", description: "run command" }

        for (const output of ["a", "a", "ab"]) {
          controller.push(
            toolEvent(sessionId, cwd, {
              callID: "call_1",
              tool: "bash",
              status: "running",
              input,
              metadata: { output },
            }),
          )
        }
        await new Promise((r) => setTimeout(r, 20))

        const snapshots = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .filter((u) => isToolCallUpdate(u.update))
          .map((u) => inProgressText(u.update))

        expect(snapshots).toEqual(["a", undefined, "ab"])
        stop()
      },
    })
  })

  test("emits synthetic pending before first running update for any tool", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_bash",
            tool: "bash",
            status: "running",
            input: { command: "echo hi", description: "run command" },
            metadata: { output: "hi\n" },
          }),
        )
        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_read",
            tool: "read",
            status: "running",
            input: { filePath: "/tmp/example.txt" },
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        const types = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .map((u) => u.update.sessionUpdate)
          .filter((u) => u === "tool_call" || u === "tool_call_update")
        expect(types).toEqual(["tool_call", "tool_call_update", "tool_call", "tool_call_update"])

        const pendings = sessionUpdates.filter(
          (u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call",
        )
        expect(pendings.every((p) => p.update.sessionUpdate === "tool_call" && p.update.status === "pending")).toBe(
          true,
        )
        stop()
      },
    })
  })

  test("does not emit duplicate synthetic pending after replayed running tool", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop, sdk } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const input = { command: "echo hi", description: "run command" }

        sdk.session.messages = async () => ({
          data: [
            {
              info: {
                role: "assistant",
                sessionID: sessionId,
              },
              parts: [
                {
                  type: "tool",
                  callID: "call_1",
                  tool: "bash",
                  state: {
                    status: "running",
                    input,
                    metadata: { output: "hi\n" },
                    time: { start: Date.now() },
                  },
                },
              ],
            },
          ],
        })

        await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)
        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_1",
            tool: "bash",
            status: "running",
            input,
            metadata: { output: "hi\nthere\n" },
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        const types = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .map((u) => u.update)
          .filter((u) => "toolCallId" in u && u.toolCallId === "call_1")
          .map((u) => u.sessionUpdate)
          .filter((u) => u === "tool_call" || u === "tool_call_update")

        expect(types).toEqual(["tool_call", "tool_call_update", "tool_call_update"])
        stop()
      },
    })
  })

  test("clears bash snapshot marker on pending state", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const input = { command: "echo hello", description: "run command" }

        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_1",
            tool: "bash",
            status: "running",
            input,
            metadata: { output: "a" },
          }),
        )
        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_1",
            tool: "bash",
            status: "pending",
            input,
            raw: '{"command":"echo hello"}',
          }),
        )
        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_1",
            tool: "bash",
            status: "running",
            input,
            metadata: { output: "a" },
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        const snapshots = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .filter((u) => isToolCallUpdate(u.update))
          .map((u) => inProgressText(u.update))

        expect(snapshots).toEqual(["a", "a"])
        stop()
      },
    })
  })

  test("ignores user message.part.updated text chunks during prompt turn", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop, sdk } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        sdk.session.message = async () => ({
          data: {
            info: {
              id: "msg_user",
              role: "user",
              sessionID: sessionId,
            },
            parts: [
              {
                id: "part_user",
                type: "text",
                text: "typed prompt",
              },
            ],
          },
        })

        controller.push({
          directory: cwd,
          payload: {
            type: "message.part.updated",
            properties: {
              sessionID: sessionId,
              part: {
                id: "part_user",
                sessionID: sessionId,
                messageID: "msg_user",
                type: "text",
                text: "typed prompt",
              },
            },
          },
        } as any)
        await new Promise((r) => setTimeout(r, 20))

        const userChunks = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .filter((u) => u.update.sessionUpdate === "user_message_chunk")
        expect(userChunks).toHaveLength(0)
        stop()
      },
    })
  })

  test("includes kind, raw input, and locations on synthetic pending tool calls", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const input = { filePath: "/tmp/example.txt" }

        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_read",
            tool: "read",
            status: "running",
            input,
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        const pending = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .map((u) => u.update)
          .find((u) => isToolCall(u) && u.toolCallId === "call_read")
        expect(pending && isToolCall(pending)).toBe(true)
        expect(isToolCall(pending!) ? pending!.kind : undefined).toBe("read")
        expect(isToolCall(pending!) ? pending!.rawInput : undefined).toEqual(input)
        expect(isToolCall(pending!) ? pending!.locations : undefined).toEqual([{ path: "/tmp/example.txt" }])
        stop()
      },
    })
  })

  test("handles synthetic pending tool calls without input", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        controller.push({
          directory: cwd,
          payload: {
            type: "message.part.updated",
            properties: {
              sessionID: sessionId,
              time: Date.now(),
              part: {
                id: "part_missing_input",
                sessionID: sessionId,
                messageID: "msg_missing_input",
                type: "tool",
                callID: "call_missing_input",
                tool: "read",
                state: {
                  status: "running",
                  time: { start: Date.now() },
                },
              },
            },
          },
        } as any)
        await new Promise((r) => setTimeout(r, 20))

        const pending = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .map((u) => u.update)
          .find((u) => isToolCall(u) && u.toolCallId === "call_missing_input")
        expect(pending && isToolCall(pending)).toBe(true)
        expect(isToolCall(pending!) ? pending!.rawInput : undefined).toEqual({})
        expect(isToolCall(pending!) ? pending!.locations : undefined).toEqual([])
        stop()
      },
    })
  })

  test("classifies apply_patch as edit and agent task tools as think", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const legacyTaskTool = ["ta", "sk"].join("")

        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_patch",
            tool: "apply_patch",
            status: "running",
            input: { filePath: "/tmp/example.txt" },
          }),
        )
        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_agent",
            tool: "agent",
            status: "running",
            input: { subagent_type: "build", description: "check build", prompt: "run tests" },
          }),
        )
        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_task",
            tool: legacyTaskTool,
            status: "running",
            input: { description: "think", prompt: "inspect" },
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        const kindByCall = new Map(
          sessionUpdates
            .filter((u) => u.sessionId === sessionId)
            .map((u) => u.update)
            .filter(isToolCall)
            .map((u) => [u.toolCallId, u.kind]),
        )

        expect(kindByCall.get("call_patch")).toBe("edit")
        expect(kindByCall.get("call_agent")).toBe("think")
        expect(kindByCall.get("call_task")).toBe("think")
        stop()
      },
    })
  })

  test("does not emit an empty diff block for completed apply_patch calls", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const patchText = [
          "*** Begin Patch",
          "*** Update File: example.txt",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n")

        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_patch",
            tool: "apply_patch",
            status: "completed",
            input: { patchText },
            output: "Success. Updated the following files:\nM example.txt",
            metadata: { diff: "diff --git a/example.txt b/example.txt" },
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        const completed = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .map((u) => u.update)
          .find((u) => isToolCallUpdate(u) && u.toolCallId === "call_patch" && u.status === "completed")

        expect(completed && isToolCallUpdate(completed)).toBe(true)
        expect(isToolCallUpdate(completed!) ? completed!.kind : undefined).toBe("edit")
        expect(isToolCallUpdate(completed!) ? completed!.content?.some((item) => item.type === "diff") : true).toBe(
          false,
        )
        expect(isToolCallUpdate(completed!) ? completed!.rawOutput : undefined).toEqual({
          output: "Success. Updated the following files:\nM example.txt",
          metadata: { diff: "diff --git a/example.txt b/example.txt" },
        })
        stop()
      },
    })
  })

  test("shows concise read content while preserving full raw output", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const fullOutput = [
          "<path>/tmp/example.txt</path>",
          "<type>file</type>",
          "<content>",
          "1: alpha",
          "2: beta",
          "</content>",
        ].join("\n")

        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_read",
            tool: "read",
            status: "completed",
            input: { filePath: "/tmp/example.txt" },
            output: fullOutput,
            title: "example.txt",
            metadata: {
              display: {
                type: "file",
                path: "/tmp/example.txt",
                text: "alpha\nbeta",
                lineStart: 1,
                lineEnd: 2,
                totalLines: 2,
                truncated: false,
              },
            },
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        const completed = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .map((u) => u.update)
          .find((u) => isToolCallUpdate(u) && u.toolCallId === "call_read" && u.status === "completed")
        expect(completed && isToolCallUpdate(completed)).toBe(true)
        const textContent = isToolCallUpdate(completed!)
          ? completed!.content?.find((item) => item.type === "content" && item.content.type === "text")
          : undefined
        const text =
          textContent?.type === "content" && textContent.content.type === "text" ? textContent.content.text : ""

        expect(text).toBe("alpha\nbeta")
        expect(text).not.toContain("<path>")
        expect(text).not.toContain("<content>")
        expect(text).not.toContain("1: alpha")
        expect(isToolCallUpdate(completed!) ? completed!.rawOutput : undefined).toEqual({
          output: fullOutput,
          metadata: {
            display: {
              type: "file",
              path: "/tmp/example.txt",
              text: "alpha\nbeta",
              lineStart: 1,
              lineEnd: 2,
              totalLines: 2,
              truncated: false,
            },
          },
        })
        stop()
      },
    })
  })

  test("keeps read continuation guidance in concise file content", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_read_partial",
            tool: "read",
            status: "completed",
            input: { filePath: "/tmp/example.txt" },
            output: "raw read output with Use offset=3 to continue.",
            title: "example.txt",
            metadata: {
              display: {
                type: "file",
                path: "/tmp/example.txt",
                text: "alpha\nbeta",
                lineStart: 1,
                lineEnd: 2,
                totalLines: 20,
                truncated: true,
              },
            },
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        const completed = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .map((u) => u.update)
          .find((u) => isToolCallUpdate(u) && u.toolCallId === "call_read_partial" && u.status === "completed")
        expect(completed && isToolCallUpdate(completed)).toBe(true)
        const textContent = isToolCallUpdate(completed!)
          ? completed!.content?.find((item) => item.type === "content" && item.content.type === "text")
          : undefined
        const text =
          textContent?.type === "content" && textContent.content.type === "text" ? textContent.content.text : ""

        expect(text).toBe("alpha\nbeta\n\n(Showing lines 1-2. Use offset=3 to continue.)")
        expect(isToolCallUpdate(completed!) ? completed!.rawOutput : undefined).toMatchObject({
          output: "raw read output with Use offset=3 to continue.",
        })
        stop()
      },
    })
  })

  test("keeps read continuation guidance in concise directory content", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)

        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_read_dir_partial",
            tool: "read",
            status: "completed",
            input: { filePath: "/tmp/example" },
            output: "raw directory output with Use offset=3 to continue.",
            title: "example",
            metadata: {
              display: {
                type: "directory",
                path: "/tmp/example",
                entries: ["one.txt", "two.txt"],
                offset: 1,
                totalEntries: 8,
                truncated: true,
              },
            },
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        const completed = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .map((u) => u.update)
          .find((u) => isToolCallUpdate(u) && u.toolCallId === "call_read_dir_partial" && u.status === "completed")
        expect(completed && isToolCallUpdate(completed)).toBe(true)
        const textContent = isToolCallUpdate(completed!)
          ? completed!.content?.find((item) => item.type === "content" && item.content.type === "text")
          : undefined
        const text =
          textContent?.type === "content" && textContent.content.type === "text" ? textContent.content.text : ""

        expect(text).toBe("one.txt\ntwo.txt\n\n(Showing 2 of 8 entries. Use offset=3 to continue.)")
        expect(isToolCallUpdate(completed!) ? completed!.rawOutput : undefined).toMatchObject({
          output: "raw directory output with Use offset=3 to continue.",
        })
        stop()
      },
    })
  })

  test("includes image attachments as content blocks on completed tool calls", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { agent, controller, sessionUpdates, stop } = createFakeAgent()
        const cwd = "/tmp/opencode-acp-test"
        const sessionId = await agent.newSession({ cwd, mcpServers: [] } as any).then((x) => x.sessionId)
        const image: FilePart = {
          id: "file_1",
          sessionID: sessionId,
          messageID: "msg_call_1",
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,iVBORw0KGgoAAAA=",
        }
        // A non-image attachment must be skipped, not turned into a content block.
        const textFile: FilePart = {
          id: "file_2",
          sessionID: sessionId,
          messageID: "msg_call_1",
          type: "file",
          mime: "text/plain",
          url: "data:text/plain;base64,aGVsbG8=",
        }
        // A malformed data URL (many ";" and no ";base64,") must be skipped
        // quickly — it is the ReDoS-shaped input the parser guards against.
        const malformed: FilePart = {
          id: "file_3",
          sessionID: sessionId,
          messageID: "msg_call_1",
          type: "file",
          mime: "image/png",
          url: "data:image/png" + ";".repeat(64) + "x",
        }

        controller.push(
          toolEvent(sessionId, cwd, {
            callID: "call_1",
            tool: "bash",
            status: "completed",
            input: { command: "screenshot" },
            output: "captured",
            attachments: [image, textFile, malformed],
          }),
        )
        await new Promise((r) => setTimeout(r, 20))

        const update = sessionUpdates
          .filter((u) => u.sessionId === sessionId)
          .map((u) => u.update)
          .find((u) => isToolCallUpdate(u) && u.toolCallId === "call_1" && u.status === "completed")
        expect(update && isToolCallUpdate(update)).toBe(true)

        const content = isToolCallUpdate(update!) ? update!.content : undefined
        expect(content).toContainEqual({
          type: "content",
          content: { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAA=" },
        })
        // The text output is still present alongside the image.
        expect(
          content?.some(
            (c) => c.type === "content" && c.content.type === "text" && c.content.text === "captured",
          ),
        ).toBe(true)
        // Only the image attachment becomes an image block; text/plain is dropped.
        const imageBlocks = content?.filter((c) => c.type === "content" && c.content.type === "image")
        expect(imageBlocks).toHaveLength(1)
        stop()
      },
    })
  })
})
