import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderTransform, type Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Permission } from "../../src/permission"
import { fromDeniedRule } from "../../src/permission/diagnostic"
import { TOOL_FAILURE_HINTS } from "../../src/session/tool-failure"
import { errorMessage } from "../../src/util/error"

const sessionID = SessionID.make("session")
const providerID = ProviderID.make("test")
const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelID.make("test") },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: MessageV2.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): MessageV2.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id),
    sessionID,
    messageID: MessageID.make(messageID),
  }
}

describe("session.message-v2.toModelMessage", () => {
  test("filters out messages with no parts", async () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("filters out messages with only ignored parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters out assistant recovery notice parts", async () => {
    const messageID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(messageID, "m-user"),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "notice",
            kind: "safe_retry_failed",
            time: { created: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters out user messages with only empty text parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters empty user text parts while keeping non-empty parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "hello",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("includes synthetic text parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("converts user text/file parts and injects compaction/subtask prompts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
          {
            ...basePart(messageID, "p3"),
            type: "file",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
          },
          {
            ...basePart(messageID, "p4"),
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
          },
          {
            ...basePart(messageID, "p5"),
            type: "file",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
          {
            ...basePart(messageID, "p7"),
            type: "subtask",
            prompt: "prompt",
            description: "desc",
            agent: "agent",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: "https://example.com/img.png",
          },
          { type: "text", text: "What did we do so far?" },
          { type: "text", text: "The following tool was executed by the user" },
        ],
      },
    ])
  })

  test("converts assistant tool completion into tool-call + tool-result messages with attachments", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "data:image/png;base64,Zm9v",
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "content",
              value: [
                { type: "text", text: "ok" },
                { type: "media", mediaType: "image/png", data: "Zm9v" },
              ],
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("converts pdf tool attachments into media tool results", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "read pdf",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "report.pdf" },
              output: "PDF read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "application/pdf",
                  filename: "report.pdf",
                  url: "data:application/pdf;base64,JVBERi0=",
                },
              ],
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const [, , tool] = await MessageV2.toModelMessages(input, model)
    expect(tool).toMatchObject({
      role: "tool",
      content: [
        {
          output: {
            type: "content",
            value: [
              { type: "text", text: "PDF read successfully" },
              { type: "media", mediaType: "application/pdf", data: "JVBERi0=" },
            ],
          },
        },
      ],
    })
  })

  test("omits empty text when tool output only has media attachments", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "inspect image",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "image.png" },
              output: "",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "image.png",
                  url: "data:image/png;base64,aW1hZ2U=",
                },
              ],
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const [, , tool] = await MessageV2.toModelMessages(input, model)
    expect(tool).toMatchObject({
      role: "tool",
      content: [
        {
          output: {
            type: "content",
            value: [{ type: "media", mediaType: "image/png", data: "aW1hZ2U=" }],
          },
        },
      ],
    })
  })

  test("moves bedrock pdf tool-result media into a separate user message", async () => {
    const bedrockModel: Provider.Model = {
      ...model,
      id: ModelID.make("amazon-bedrock/anthropic.claude-sonnet-4-6"),
      providerID: ProviderID.make("amazon-bedrock"),
      api: {
        id: "anthropic.claude-sonnet-4-6",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
          pdf: true,
        },
      },
    }
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64")
    const userID = "m-user-bedrock-pdf"
    const assistantID = "m-assistant-bedrock-pdf"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-bedrock-pdf"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-bedrock-pdf"),
            type: "tool",
            callID: "call-bedrock-pdf-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/example.pdf" },
              output: "PDF read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-bedrock-pdf-1"),
                  type: "file",
                  mime: "application/pdf",
                  filename: "example.pdf",
                  url: `data:application/pdf;base64,${pdf}`,
                },
              ],
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, bedrockModel)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-bedrock-pdf-1",
            toolName: "read",
            input: { filePath: "/tmp/example.pdf" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-bedrock-pdf-1",
            toolName: "read",
            output: { type: "text", value: "PDF read successfully" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Attached media from tool result:" },
          { type: "file", mediaType: "application/pdf", filename: "example.pdf", data: `data:application/pdf;base64,${pdf}` },
        ],
      },
    ])
  })

  test("omits provider metadata when assistant model differs", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, { providerID: "other", modelID: "other" }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "reasoning",
            text: "thinking",
            metadata: { openai: { reasoning: "meta" } },
            time: { start: 0 },
          },
          {
            ...basePart(assistantID, "a3"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          { type: "text", text: "thinking" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("replaces compacted tool output with placeholder", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[Old tool result content cleared]" },
          },
        ],
      },
    ])
  })

  test("converts assistant tool error into error-text tool result", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {
                diagnostics: {
                  failure: {
                    errorKind: "invalid_arguments",
                    recoveryHint: TOOL_FAILURE_HINTS.invalid_arguments,
                  },
                },
              },
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "error-text",
              value: `nope\n\nTool failure reason: invalid_arguments. Recovery hint: ${TOOL_FAILURE_HINTS.invalid_arguments}`,
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("bounds long tool inputs separately from tool output for compaction replay", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const longQuestion = `${"Tauri backend Rust, OpenCode server TypeScript. ".repeat(200)}UNIQUE_LONG_QUESTION_TAIL`
    const error =
      'The question tool was called with invalid arguments: SchemaError(Missing key at ["questions"][0]["options"][3]["description"]).\nPlease rewrite the input so it satisfies the expected schema.'
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "ask a question",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-question",
            tool: "question",
            state: {
              status: "error",
              input: {
                questions: [
                  {
                    question: longQuestion,
                    header: "Runtime",
                    options: [
                      { label: "External", description: "Run Node separately" },
                      { label: "Rust", description: "Rewrite backend" },
                      { label: "Shell", description: "Spawn child process" },
                      { label: "Unsure" },
                    ],
                  },
                ],
              },
              error,
              time: { start: 0, end: 1 },
              metadata: {},
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const [, assistant, tool] = await MessageV2.toModelMessages(input, model, {
      toolInputMaxChars: 200,
      toolOutputMaxChars: 32,
    })
    const toolCall = assistant?.content[0] as any
    const toolResult = tool?.content[0] as any

    const serializedInput = JSON.stringify(toolCall.input)
    expect(serializedInput.length).toBeLessThanOrEqual(200)
    expect(serializedInput).not.toContain("UNIQUE_LONG_QUESTION_TAIL")
    expect(serializedInput).toContain("Tool input truncated")
    expect(toolResult.output.value).toContain("SchemaError")
  })

  test("bounds the entire serialized tool input for compaction replay", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "write many todos",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-todos",
            tool: "todowrite",
            state: {
              status: "completed",
              input: {
                todos: Array.from({ length: 100 }, (_, index) => ({
                  content: `short todo item ${index}`,
                  status: index % 2 === 0 ? "completed" : "pending",
                })),
              },
              output: "ok",
              title: "",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const [, assistant] = await MessageV2.toModelMessages(input, model, {
      toolInputMaxChars: 600,
    })
    const toolCall = assistant?.content[0] as any
    const serializedInput = JSON.stringify(toolCall.input)

    expect(serializedInput.length).toBeLessThanOrEqual(600)
    expect(serializedInput).toContain("Tool input truncated")
    expect(serializedInput).not.toContain("short todo item 99")
  })

  test("uses a flat truncation marker for object tool input projections", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run a tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-object",
            tool: "example",
            state: {
              status: "completed",
              input: {
                first: "a".repeat(30),
                second: "b".repeat(30),
                third: "c".repeat(30),
              },
              output: "ok",
              title: "",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const [, assistant] = await MessageV2.toModelMessages(input, model, {
      toolInputMaxChars: 90,
    })
    const toolCall = assistant?.content[0] as any

    expect(typeof toolCall.input._truncated).toBe("string")
    expect(toolCall.input._truncated).toContain("Tool input truncated")
  })

  test("uses empty tool input for non-positive projection budgets", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run a tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-zero",
            tool: "example",
            state: {
              status: "completed",
              input: { value: "kept out" },
              output: "ok",
              title: "",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const [, assistant] = await MessageV2.toModelMessages(input, model, {
      toolInputMaxChars: 0,
    })
    const toolCall = assistant?.content[0] as any

    expect(toolCall.input).toBe("")
  })

  test("stops traversing oversized tool input after the projection budget is exhausted", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    let contentAccesses = 0
    const todos = Array.from({ length: 5_000 }, (_, index) => ({
      get content() {
        contentAccesses++
        return `small todo item ${index}`
      },
      status: "pending",
    }))
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "write many todos",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-todos",
            tool: "todowrite",
            state: {
              status: "completed",
              input: { todos },
              output: "ok",
              title: "",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const [, assistant] = await MessageV2.toModelMessages(input, model, {
      toolInputMaxChars: 600,
    })
    const toolCall = assistant?.content[0] as any
    const serializedInput = JSON.stringify(toolCall.input)

    expect(serializedInput.length).toBeLessThanOrEqual(600)
    expect(serializedInput).toContain("Tool input truncated")
    expect(contentAccesses).toBeLessThan(500)
  })

  test("converts permission denial diagnostic into model-facing error text", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const diagnostic = fromDeniedRule({
      permission: "bash",
      blockedCommand: "rm file.txt",
      matchedRule: { permission: "bash", pattern: "rm *", action: "deny" },
      platform: "darwin",
    })
    expect(diagnostic).toBeDefined()
    if (!diagnostic) return

    const denied = new Permission.DeniedError({
      ruleset: [
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "rm *", action: "deny" },
      ],
      diagnostic,
    })
    const rendered = errorMessage(denied)

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "remove the file",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "rm file.txt" },
              error: rendered,
              time: { start: 0, end: 1 },
              metadata: {},
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const messages = await MessageV2.toModelMessages(input, model)
    const toolResult = messages[2]?.content[0]

    expect(toolResult).toEqual({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "bash",
      output: { type: "error-text", value: rendered },
    })
    expect(rendered).toContain("Command blocked: rm file.txt")
    expect(rendered).toContain('Matched rule: bash "rm *" deny')
    expect(rendered).not.toContain("Here are some of the relevant rules")
  })

  test("forwards partial bash output for aborted tool calls", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const output = [
      "31403",
      "12179",
      "4575",
      "",
      "<bash_metadata>",
      "User aborted the command",
      "</bash_metadata>",
    ].join("\n")

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
              error: "Tool execution aborted",
              metadata: { interrupted: true, output },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: output },
          },
        ],
      },
    ])
  })

  test("filters assistant messages with non-abort errors", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject() as MessageV2.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters fatal assistant errors even when a tool part is present", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(
          assistantID,
          userID,
          new MessageV2.APIError({
            message: "fatal provider failure",
            isRetryable: false,
          }).toObject() as MessageV2.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-fatal",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "deploy" },
              error: "tool-level error is not enough to recover a fatal assistant turn",
              time: { start: 0, end: 1 },
              metadata: {},
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
    ])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", async () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"]

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID2, "b1"),
            type: "step-start",
          },
          {
            ...basePart(assistantID2, "b2"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
    ])
  })

  test("preserves OpenRouter reasoning details through provider transform", async () => {
    const assistantID = "m-assistant"
    const openrouterModel: Provider.Model = {
      ...model,
      id: ModelID.make("deepseek/deepseek-v4-pro"),
      providerID: ProviderID.make("openrouter"),
      api: {
        id: "deepseek/deepseek-v4-pro",
        url: "https://openrouter.ai/api/v1",
        npm: "@openrouter/ai-sdk-provider",
      },
      capabilities: {
        ...model.capabilities,
        reasoning: true,
        interleaved: { field: "reasoning_details" },
      },
    }
    const reasoningDetails = [
      {
        type: "reasoning.text",
        text: "thinking",
        format: "unknown",
        index: 0,
      },
    ]
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent", undefined, {
          providerID: openrouterModel.providerID,
          modelID: openrouterModel.id,
        }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
            metadata: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "text",
            text: "answer",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(
      ProviderTransform.message(await MessageV2.toModelMessages(input, openrouterModel), openrouterModel, {}),
    ).toStrictEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          { type: "text", text: "answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("drops messages that only contain step-start parts", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("converts pending/running tool calls to error results to prevent dangling tool_use", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { cmd: "ls" },
              raw: "",
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-running",
            tool: "read",
            state: {
              status: "running",
              input: { path: "/tmp" },
              time: { start: 0 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-running",
            toolName: "read",
            input: { path: "/tmp" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-pending",
            toolName: "bash",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
          {
            type: "tool-result",
            toolCallId: "call-running",
            toolName: "read",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
        ],
      },
    ])
  })

  test("substitutes space for empty text between Anthropic signed reasoning blocks", async () => {
    const assistantID = "m-assistant"
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "step-start" },
          {
            ...basePart(assistantID, "p2"),
            type: "reasoning",
            text: "thinking-one",
            metadata: { anthropic: { signature: "sig1" } },
          },
          { ...basePart(assistantID, "p3"), type: "text", text: "" },
          { ...basePart(assistantID, "p4"), type: "step-start" },
          {
            ...basePart(assistantID, "p5"),
            type: "reasoning",
            text: "thinking-two",
            metadata: { anthropic: { signature: "sig2" } },
          },
          { ...basePart(assistantID, "p6"), type: "text", text: "the answer" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(2)
    expect((result[0].content as any[]).find((p) => p.type === "text").text).toBe(" ")
    expect((result[1].content as any[]).find((p) => p.type === "text").text).toBe("the answer")
  })

  test("leaves empty text alone when reasoning signature is under bedrock namespace", async () => {
    const assistantID = "m-assistant-bedrock"
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "reasoning",
            text: "thinking-bedrock",
            metadata: { bedrock: { signature: "bedrock-sig" } },
          },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    expect((result[0].content as any[]).filter((p) => p.type === "text").map((p) => p.text)).toStrictEqual([
      "",
      "answer",
    ])
  })
})

describe("session.message-v2.fromError", () => {
  test("serializes context_length_exceeded as ContextOverflowError", () => {
    const input = {
      type: "error",
      error: {
        code: "context_length_exceeded",
      },
    }
    const result = MessageV2.fromError(input, { providerID })

    expect(result).toStrictEqual({
      name: "ContextOverflowError",
      data: {
        message: "Input exceeds context window of this model",
        responseBody: JSON.stringify(input),
      },
    })
  })

  test("serializes response error codes", () => {
    const cases = [
      {
        code: "insufficient_quota",
        message: "Quota exceeded. Check your plan and billing details.",
        kind: "quota_exhausted",
      },
      {
        code: "usage_not_included",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        kind: "quota_exhausted",
      },
      {
        code: "invalid_prompt",
        message: "Invalid prompt from test",
        kind: "invalid_request",
      },
    ] as const

    cases.forEach((item) => {
      const input = {
        type: "error",
        error: {
          code: item.code,
          message: item.code === "invalid_prompt" ? item.message : undefined,
        },
      }
      const result = MessageV2.fromError(input, { providerID })

      expect(result).toStrictEqual({
        name: "APIError",
        data: {
          message: item.message,
          isRetryable: false,
          responseBody: JSON.stringify(input),
          providerID,
          providerFailure: { kind: item.kind, code: item.code },
        },
      })
    })
  })

  test("serializes OpenAI response server_error stream chunks as retryable APIError", () => {
    const body = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "server_error",
        code: "server_error",
        message:
          "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_77eccd008d984bf6bf82d1b2c2b68715 in your message.",
        param: null,
      },
    }
    const result = MessageV2.fromError({ message: JSON.stringify(body) }, { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: body.error.message,
        isRetryable: true,
        responseBody: JSON.stringify(body),
        providerID,
        providerFailure: { kind: "server_overload", code: "server_error" },
      },
    })
  })

  test("classifies Error-wrapped stream error payloads, not just plain objects", () => {
    const body = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "server_error",
        code: "server_error",
        message: "An error occurred while processing your request.",
        param: null,
      },
    }
    // Same payload as the plain-object case above, but wrapped in an Error
    // instance — the shape it actually arrives in from the stream "error" part
    // (processor throws value.error) and the iterator-throw mapper in llm.ts.
    const result = MessageV2.fromError(new Error(JSON.stringify(body)), { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: body.error.message,
        isRetryable: true,
        responseBody: JSON.stringify(body),
        providerID,
        providerFailure: { kind: "server_overload", code: "server_error" },
      },
    })
  })

  test("classifies bare response.failed stream error payloads", () => {
    const body = {
      code: "server_error",
      message: "The provider failed while streaming the response.",
    }
    const result = MessageV2.fromError(body, { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: body.message,
        isRetryable: true,
        responseBody: JSON.stringify(body),
        providerID,
        providerFailure: { kind: "server_overload", code: "server_error" },
      },
    })
  })

  test("leaves untyped nested error envelopes as UnknownError", () => {
    const body = {
      error: {
        code: "server_error",
        message: "The provider failed while streaming the response.",
      },
    }
    const result = MessageV2.fromError(body, { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: { message: JSON.stringify(body) },
    })
  })

  test("classifies stream error payloads from Error cause bodies", () => {
    const body = {
      type: "error",
      error: {
        code: "server_is_overloaded",
        message: "The provider is overloaded.",
      },
    }
    const error = new Error("provider stream failed", { cause: { body } })
    const result = MessageV2.fromError(error, { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: body.error.message,
        isRetryable: true,
        responseBody: JSON.stringify(body),
        providerID,
        providerFailure: { kind: "server_overload", code: "server_is_overloaded" },
      },
    })
  })

  test("upgrades typed Error-wrapped payloads with unhandled codes to APIError(unknown)", () => {
    // A typed provider error body (type:"error" + error object) is a recognized
    // failure shape, so even an unhandled code becomes a structured APIError that
    // preserves code/responseBody for the frontend — rather than an opaque
    // UnknownError blob. The code is unknown (not transient), so it stays
    // non-retryable, matching the prior Unknown -> classifyRetry verdict.
    const payload = JSON.stringify({ type: "error", error: { code: "bad_request" } })
    const result = MessageV2.fromError(new Error(payload), { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: payload,
        isRetryable: false,
        responseBody: payload,
        providerID,
        providerFailure: { kind: "unknown", code: "bad_request" },
      },
    })
  })

  test("detects context overflow from APICallError provider messages", () => {
    const cases = [
      "prompt is too long: 213462 tokens > 200000 maximum",
      "Your input exceeds the context window of this model",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
      "Please reduce the length of the messages or completion",
      "400 status code (no body)",
      "413 status code (no body)",
    ]

    cases.forEach((message) => {
      const error = new APICallError({
        message,
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 400,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      })
      const result = MessageV2.fromError(error, { providerID })
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })
  })

  test("detects context overflow from context_length_exceeded code in response body", () => {
    const error = new APICallError({
      message: "Request failed",
      url: "https://example.com",
      requestBodyValues: {},
      statusCode: 422,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        error: {
          message: "Some message",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID })
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
  })

  test("does not classify 429 no body as context overflow", () => {
    const result = MessageV2.fromError(
      new APICallError({
        message: "429 status code (no body)",
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      }),
      { providerID },
    )
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(false)
    expect(MessageV2.APIError.isInstance(result)).toBe(true)
  })

  test("serializes unknown inputs", () => {
    const result = MessageV2.fromError(123, { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "123",
      },
    })
  })

  test("serializes generic errors with their message", () => {
    const result = MessageV2.fromError(new Error("synthetic failure"), { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "synthetic failure",
      },
    })
  })

  test("classifies ZlibError from fetch as retryable APIError", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0
    ;(zlibError as any).path = ""

    const result = MessageV2.fromError(zlibError, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect((result as MessageV2.APIError).data.message).toInclude("decompression")
  })

  test("classifies ZlibError as AbortedError when abort context is provided", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0

    const result = MessageV2.fromError(zlibError, { providerID, aborted: true })

    expect(result.name).toBe("MessageAbortedError")
  })

  test("classifies UND_ERR_SOCKET TypeError as retryable APIError", () => {
    const socketCause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" })
    const error = new TypeError("terminated", { cause: socketCause })

    const result = MessageV2.fromError(error, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect((result as MessageV2.APIError).data.message).toInclude("terminated")
  })

  test("classifies ECONNREFUSED as retryable APIError", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    })

    const result = MessageV2.fromError(error, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
  })

  test("classifies ETIMEDOUT as retryable APIError", () => {
    const error = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
      syscall: "connect",
    })

    const result = MessageV2.fromError(error, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
  })

  test("populates providerFailure for transport disconnects", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    })

    const result = MessageV2.fromError(error, { providerID })

    expect((result as MessageV2.APIError).data.providerFailure).toStrictEqual({
      kind: "transport_disconnect",
      code: "ECONNREFUSED",
    })
  })

  test("populates providerFailure for decompression failures", () => {
    const zlibError = Object.assign(
      new Error('ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages".'),
      { code: "ZlibError", errno: 0, path: "" },
    )

    const result = MessageV2.fromError(zlibError, { providerID })

    expect((result as MessageV2.APIError).data.providerFailure).toStrictEqual({
      kind: "decompression",
      code: "ZlibError",
    })
  })

  test("classifies APICallError status codes into providerFailure kinds", () => {
    const cases = [
      { statusCode: 400, kind: "invalid_request" },
      { statusCode: 401, kind: "auth" },
      { statusCode: 402, kind: "quota_exhausted" },
      { statusCode: 403, kind: "auth" },
      { statusCode: 422, kind: "invalid_request" },
      { statusCode: 429, kind: "rate_limit" },
      { statusCode: 503, kind: "server_overload" },
    ] as const

    cases.forEach(({ statusCode, kind }) => {
      const error = new APICallError({
        message: `${statusCode} failure`,
        url: "https://example.com",
        requestBodyValues: {},
        statusCode,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: statusCode >= 500,
      })
      const result = MessageV2.fromError(error, { providerID })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      expect((result as MessageV2.APIError).data.providerFailure).toStrictEqual({
        kind,
        code: undefined,
      })
    })
  })
})

describe("session.message-v2.fromError — PR1 classification completeness", () => {
  const deepseekBalanceBody = JSON.stringify({
    error: { message: "Insufficient Balance", code: "invalid_request_error", type: "unknown_error" },
  })

  const makeApiError = (overrides: Partial<ConstructorParameters<typeof APICallError>[0]>) =>
    new APICallError({
      message: "",
      url: "https://api.deepseek.com/chat/completions",
      requestBodyValues: {},
      responseHeaders: { "content-type": "application/json" },
      isRetryable: false,
      ...overrides,
    })

  test("classifies a DeepSeek 402 balance error as quota_exhausted and surfaces the real reason", () => {
    // 402 + nested {error:{message}} is the reported bug: it was shown as
    // "Connection lost". The nested provider message must be extracted (not the
    // raw responseBody dump) and the kind must be quota_exhausted.
    const result = MessageV2.fromError(
      makeApiError({ message: "Payment Required", statusCode: 402, responseBody: deepseekBalanceBody }),
      { providerID },
    )

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    const data = (result as MessageV2.APIError).data
    expect(data.providerFailure?.kind).toBe("quota_exhausted")
    expect(data.message).toContain("Insufficient Balance")
    expect(data.message).not.toContain("invalid_request_error")
  })

  test("surfaces the nested balance reason even when the SDK message is not the HTTP reason phrase", () => {
    // Regression guard: message() used to early-return whenever the SDK message
    // differed from the bare status phrase, which dropped the nested
    // {error:{message}} reason for any provider/SDK that sets a custom message
    // (e.g. "API call failed"). The real reason must still reach the user.
    const result = MessageV2.fromError(
      makeApiError({ message: "API call failed", statusCode: 402, responseBody: deepseekBalanceBody }),
      { providerID },
    )

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    const data = (result as MessageV2.APIError).data
    expect(data.message).toContain("Insufficient Balance")
    expect(data.providerFailure?.kind).toBe("quota_exhausted")
  })

  test("classifies a DeepSeek balance error as quota_exhausted even when it arrives as 400", () => {
    // Some providers return billing failures under a generic 400. The strong
    // billing pattern must override apiCallErrorKind's invalid_request verdict.
    const result = MessageV2.fromError(
      makeApiError({ message: "Bad Request", statusCode: 400, responseBody: deepseekBalanceBody }),
      { providerID },
    )

    expect((result as MessageV2.APIError).data.providerFailure?.kind).toBe("quota_exhausted")
  })

  test("does not reclassify opencode FreeUsageLimitError 429 as quota_exhausted", () => {
    // Invariant: FreeUsageLimitError must keep flowing to free_quota_exhausted ->
    // rate_limit_blocked. quota_exhausted is terminal and would stop classifyRetry
    // before the free-quota branch, breaking the countdown card.
    const result = MessageV2.fromError(
      makeApiError({
        message: "Too Many Requests",
        statusCode: 429,
        responseBody: '{"error":{"type":"FreeUsageLimitError"}}',
        responseHeaders: { "retry-after": "70" },
      }),
      { providerID: ProviderID.opencode },
    )

    expect((result as MessageV2.APIError).data.providerFailure?.kind).toBe("rate_limit")
  })

  test("does not let a rate-limit signal on a billing-shaped status become terminal quota_exhausted", () => {
    // The weak billing patterns ("quota exceeded") fire only on a 400/402/403
    // with no rate-limit signal. A Retry-After header means the provider is
    // asking us to back off, not that the account is out of money — so the
    // incidental "quota" wording must not flip the rejection into terminal
    // quota_exhausted (which would wrongly prompt a top-up). It stays the base
    // status kind.
    const result = MessageV2.fromError(
      makeApiError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({ error: { message: "Quota exceeded for this request window." } }),
        responseHeaders: { "content-type": "application/json", "retry-after": "30" },
      }),
      { providerID },
    )

    expect((result as MessageV2.APIError).data.providerFailure?.kind).toBe("invalid_request")
  })

  test("does not let weak billing wording override a 5xx server error", () => {
    // WEAK_BILLING_STATUS is {400,402,403}; a 5xx stays server_overload (and
    // retryable). Incidental "quota exceeded" wording in a transient 503 must
    // not be read as a terminal billing failure, which would stop retries on a
    // recoverable error.
    const result = MessageV2.fromError(
      makeApiError({
        message: "Service Unavailable",
        statusCode: 503,
        responseBody: JSON.stringify({ error: { message: "Service temporarily unavailable; quota exceeded." } }),
        isRetryable: true,
      }),
      { providerID },
    )

    expect((result as MessageV2.APIError).data.providerFailure?.kind).toBe("server_overload")
  })

  test("classifies stream authentication errors as auth (non-retryable)", () => {
    const body = { code: "authentication_error", message: "Invalid API key provided." }
    const result = MessageV2.fromError(body, { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: body.message,
        isRetryable: false,
        responseBody: JSON.stringify(body),
        providerID,
        providerFailure: { kind: "auth", code: "authentication_error" },
      },
    })
  })

  test("classifies stream rate-limit errors as rate_limit (retryable)", () => {
    const body = { code: "rate_limit_exceeded", message: "Rate limit reached for requests." }
    const result = MessageV2.fromError(body, { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: body.message,
        isRetryable: true,
        responseBody: JSON.stringify(body),
        providerID,
        providerFailure: { kind: "rate_limit", code: "rate_limit_exceeded" },
      },
    })
  })

  test("classifies a stream billing message as quota_exhausted regardless of code", () => {
    const body = { code: "some_provider_code", message: "Insufficient Balance" }
    const result = MessageV2.fromError(body, { providerID })

    expect((result as MessageV2.APIError).data.providerFailure?.kind).toBe("quota_exhausted")
    expect((result as MessageV2.APIError).data.isRetryable).toBe(false)
  })

  test("upgrades a typed stream body with an unknown code to APIError(unknown)", () => {
    const body = { type: "error", error: { code: "teapot_error", message: "I am a teapot." } }
    const result = MessageV2.fromError(body, { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: "I am a teapot.",
        isRetryable: false,
        responseBody: JSON.stringify(body),
        providerID,
        providerFailure: { kind: "unknown", code: "teapot_error" },
      },
    })
  })

  test("keeps a typed resource_exhausted body retryable when upgraded to APIError(unknown)", () => {
    // resource_exhausted stays unchanged in PR1: it keeps its retryable
    // "overloaded" semantics. The middle-path upgrade derives retryability from
    // the transient-looking code, so it stays retryable.
    const body = { type: "error", error: { code: "resource_exhausted", message: "Resource has been exhausted." } }
    const result = MessageV2.fromError(body, { providerID })

    expect((result as MessageV2.APIError).data.providerFailure).toStrictEqual({
      kind: "unknown",
      code: "resource_exhausted",
    })
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
  })

  test("does not treat a typed terminal quota_exhausted code as retryable", () => {
    // The transient-code heuristic must not match a terminal quota code just
    // because it contains "exhausted" — only resource_exhausted is transient.
    const body = { type: "error", error: { code: "quota_exhausted", message: "Your quota has been exhausted." } }
    const result = MessageV2.fromError(body, { providerID })

    expect((result as MessageV2.APIError).data.isRetryable).toBe(false)
  })

  test("does not retry a typed unknown error whose message merely mentions 'unavailable'", () => {
    // Regression: retryability is read from the code only. A terminal error
    // (code bad_request) whose free-text message says "unavailable" must NOT be
    // upgraded to retryable.
    const body = { type: "error", error: { code: "bad_request", message: "Model unavailable for your account." } }
    const result = MessageV2.fromError(body, { providerID })

    expect((result as MessageV2.APIError).data.providerFailure?.kind).toBe("unknown")
    expect((result as MessageV2.APIError).data.isRetryable).toBe(false)
  })

  test("treats a 429 'quota exceeded' rate limit as rate_limit, not terminal quota_exhausted", () => {
    // Google reports per-minute request limits as 429 "Quota exceeded for quota
    // metric ... per minute". 429 is Too Many Requests, so it must stay a
    // retryable rate_limit rather than a terminal billing failure.
    const responseBody = JSON.stringify({
      error: { message: "Quota exceeded for quota metric 'GenerateContent request limit per minute'." },
    })
    const result = MessageV2.fromError(
      makeApiError({
        message: "Too Many Requests",
        statusCode: 429,
        responseBody,
        isRetryable: true,
      }),
      { providerID },
    )

    expect((result as MessageV2.APIError).data.providerFailure?.kind).toBe("rate_limit")
  })

  test("leaves a bare {code} body (e.g. a Node EACCES error) as UnknownError", () => {
    // A bare top-level code is indistinguishable from a Node runtime error, so
    // the middle path must not wrap it as a provider APIError.
    const nodeError = Object.assign(new Error("permission denied reading local config"), { code: "EACCES" })
    const result = MessageV2.fromError(nodeError, { providerID })

    expect(result.name).toBe("UnknownError")
  })

  test("marks a typed opencode FreeUsageLimitError stream body retryable for free-quota routing", () => {
    // Real FreeUsageLimitError arrives as an APICallError (429); this guards the
    // typed-stream shape too: it must stay kind=unknown (not quota_exhausted) and
    // retryable so classifyRetry can reach the free_quota_exhausted branch.
    const body = { type: "error", error: { type: "FreeUsageLimitError", message: "FreeUsageLimitError" } }
    const result = MessageV2.fromError(body, { providerID: ProviderID.opencode })

    expect((result as MessageV2.APIError).data.providerFailure?.kind).toBe("unknown")
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
  })

  test("leaves untyped nested error envelopes as UnknownError (over-match guard)", () => {
    // A body with no top-level type/code is not a recognized provider error
    // shape, so it must stay Unknown.
    const body = { error: { code: "teapot_error", message: "nope" } }
    const result = MessageV2.fromError(body, { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: { message: JSON.stringify(body) },
    })
  })
})

describe("session.message-v2.APIError providerFailure back-compat", () => {
  test("parses historical APIError rows that predate providerFailure", () => {
    const legacyRow = {
      name: "APIError",
      data: {
        message: "Server error",
        isRetryable: true,
        providerID,
      },
    }

    const parsed = MessageV2.APIError.Schema.parse(legacyRow)

    expect(parsed.data.providerFailure).toBeUndefined()
  })

  test("round-trips providerFailure through the persisted schema", () => {
    const row = {
      name: "APIError",
      data: {
        message: "Rate limited",
        isRetryable: true,
        providerID,
        providerFailure: { kind: "rate_limit", code: "rate_limit_exceeded" },
      },
    }

    const parsed = MessageV2.APIError.Schema.parse(row)

    expect(parsed.data.providerFailure).toStrictEqual({
      kind: "rate_limit",
      code: "rate_limit_exceeded",
    })
  })

  test("rejects unknown providerFailure kinds", () => {
    const row = {
      name: "APIError",
      data: {
        message: "x",
        isRetryable: false,
        providerFailure: { kind: "totally_made_up" },
      },
    }

    expect(() => MessageV2.APIError.Schema.parse(row)).toThrow()
  })
})

describe("session.message-v2.ToolStateError.reason", () => {
  const baseErrorPart = {
    status: "error" as const,
    input: { foo: "bar" },
    error: "Something went wrong",
    time: { start: 1, end: 2 },
  }

  test("decodes legacy fixture without reason field; parsed.reason is undefined", () => {
    const parsed = MessageV2.ToolStateError.parse(baseErrorPart)
    expect(parsed.reason).toBeUndefined()
  })

  test("decodes new fixture with reason: aborted", () => {
    const parsed = MessageV2.ToolStateError.parse({ ...baseErrorPart, reason: "aborted" })
    expect(parsed.reason).toBe("aborted")
  })

  test("decodes new fixture with reason: shutdown", () => {
    const parsed = MessageV2.ToolStateError.parse({ ...baseErrorPart, reason: "shutdown" })
    expect(parsed.reason).toBe("shutdown")
  })

  test("decodes new fixture with reason: tool_failure", () => {
    const parsed = MessageV2.ToolStateError.parse({ ...baseErrorPart, reason: "tool_failure" })
    expect(parsed.reason).toBe("tool_failure")
  })

  test("rejects unknown reason value", () => {
    const result = MessageV2.ToolStateError.safeParse({ ...baseErrorPart, reason: "bogus" })
    expect(result.success).toBe(false)
  })
})

describe("session.message-v2 cumulative tokens", () => {
  const cumulative = (
    input: number,
    output: number,
    reasoning: number,
    read: number,
    write: number,
    total?: number,
  ) => ({
    total,
    input,
    output,
    reasoning,
    cache: { read, write },
  })

  const stepFinishPart = (
    messageID: string,
    id: string,
    tokens: { total?: number; input: number; output: number; reasoning: number; read: number; write: number },
  ) =>
    ({
      ...basePart(messageID, id),
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: {
        total: tokens.total,
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.read, write: tokens.write },
      },
    }) as unknown as MessageV2.Part

  describe("addTokens", () => {
    test("returns the next tally when the accumulator is undefined", () => {
      expect(MessageV2.addTokens(undefined, cumulative(10, 5, 2, 30, 40))).toEqual(cumulative(10, 5, 2, 30, 40))
    })

    test("sums every field across multiple steps", () => {
      let acc = MessageV2.addTokens(undefined, cumulative(100, 10, 1, 0, 500))
      acc = MessageV2.addTokens(acc, cumulative(20, 5, 2, 480, 10))
      acc = MessageV2.addTokens(acc, cumulative(3, 1, 0, 7, 0))
      expect(acc).toEqual(cumulative(123, 16, 3, 487, 510))
    })

    test("keeps total undefined until at least one step reports it", () => {
      const noTotal = MessageV2.addTokens(undefined, cumulative(10, 0, 0, 0, 0))
      expect(noTotal.total).toBeUndefined()
      const withTotal = MessageV2.addTokens(noTotal, cumulative(10, 0, 0, 0, 0, 20))
      expect(withTotal.total).toBe(20)
    })

    test("does not throw when an accumulator is missing its cache object", () => {
      const malformed = { input: 1, output: 0, reasoning: 0 } as unknown as Parameters<typeof MessageV2.addTokens>[0]
      expect(() => MessageV2.addTokens(malformed, cumulative(1, 0, 0, 5, 5))).not.toThrow()
    })
  })

  describe("backfillCumulative", () => {
    test("rebuilds tokensCumulative from multiple step-finish parts on a legacy assistant message", () => {
      const info = assistantInfo("a1", "u1")
      const parts = [
        stepFinishPart("a1", "p1", { input: 100, output: 10, reasoning: 1, read: 0, write: 500 }),
        stepFinishPart("a1", "p2", { input: 20, output: 5, reasoning: 2, read: 480, write: 10 }),
      ]
      const result = MessageV2.backfillCumulative(info, parts) as MessageV2.Assistant
      expect(result.tokensCumulative).toEqual(cumulative(120, 15, 3, 480, 510))
    })

    test("leaves an existing tokensCumulative untouched", () => {
      const info = { ...assistantInfo("a1", "u1"), tokensCumulative: cumulative(1, 1, 1, 1, 1) } as MessageV2.Assistant
      const parts = [stepFinishPart("a1", "p1", { input: 999, output: 0, reasoning: 0, read: 999, write: 0 })]
      const result = MessageV2.backfillCumulative(info, parts) as MessageV2.Assistant
      expect(result.tokensCumulative).toEqual(cumulative(1, 1, 1, 1, 1))
    })

    test("returns the message unchanged when there are no step-finish parts", () => {
      const info = assistantInfo("a1", "u1")
      const result = MessageV2.backfillCumulative(info, []) as MessageV2.Assistant
      expect(result.tokensCumulative).toBeUndefined()
      expect(result).toBe(info)
    })

    test("ignores non-assistant messages", () => {
      const info = userInfo("u1")
      const parts = [stepFinishPart("u1", "p1", { input: 100, output: 0, reasoning: 0, read: 50, write: 50 })]
      expect(MessageV2.backfillCumulative(info, parts)).toBe(info)
    })
  })
})
