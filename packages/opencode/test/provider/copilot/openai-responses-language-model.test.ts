import { OpenAIResponsesLanguageModel } from "@/provider/sdk/copilot/responses/openai-responses-language-model"
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { describe, expect, mock, test } from "bun:test"

const TEST_PROMPT: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "Use a tool" }] }]

type SseChunk = Record<string, unknown>

async function collectStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader()
  const result: T[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result.push(value)
  }
  return result
}

function createEventStream(chunks: SseChunk[]) {
  const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`)
  lines.push("data: [DONE]")
  const payload = `${lines.join("\n\n")}\n\n`
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

async function streamParts(chunks: SseChunk[]) {
  const fetch = mock(async () => {
    return new Response(createEventStream(chunks), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  })
  const model = new OpenAIResponsesLanguageModel("gpt-5.2", {
    provider: "test.responses",
    url: () => "https://example.test/v1/responses",
    headers: () => ({ Authorization: "Bearer test" }),
    fetch: fetch as never,
  })
  const { stream } = await model.doStream({ prompt: TEST_PROMPT, includeRawChunks: false })
  return collectStream(stream)
}

function responseCreated(): SseChunk {
  return {
    type: "response.created",
    sequence_number: 1,
    response: {
      id: "resp_test",
      created_at: 1779358949,
      model: "gpt-5.2",
      service_tier: null,
    },
  }
}

function responseCompleted(seq = 4): SseChunk {
  return {
    type: "response.completed",
    sequence_number: seq,
    response: {
      incomplete_details: null,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: null },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: null },
      },
      service_tier: null,
    },
  }
}

function responseFailed(seq = 3): SseChunk {
  return {
    type: "response.failed",
    sequence_number: seq,
    response: {
      id: "resp_test",
      created_at: 1779358950,
      model: "gpt-5.2",
      error: { code: "server_error", message: "response failed" },
      incomplete_details: null,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: null },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: null },
      },
      service_tier: null,
    },
  }
}

async function streamPartsWithoutDone(chunks: SseChunk[]) {
  const fetch = mock(async () => {
    const lines = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`)
    const payload = `${lines.join("\n\n")}\n\n`
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(payload))
          controller.close()
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )
  })
  const model = new OpenAIResponsesLanguageModel("gpt-5.2", {
    provider: "test.responses",
    url: () => "https://example.test/v1/responses",
    headers: () => ({ Authorization: "Bearer test" }),
    fetch: fetch as never,
  })
  const { stream } = await model.doStream({ prompt: TEST_PROMPT, includeRawChunks: false })
  return collectStream(stream)
}

function functionCallAdded(
  input: {
    seq?: number
    outputIndex?: number
    itemId?: string
    callId?: string
    name?: string
    args?: string
  } = {},
): SseChunk {
  return {
    type: "response.output_item.added",
    sequence_number: input.seq ?? 2,
    output_index: input.outputIndex ?? 0,
    item: {
      type: "function_call",
      id: input.itemId ?? "fc_1",
      call_id: input.callId ?? "call_1",
      name: input.name ?? "enter-worktree",
      arguments: input.args ?? "",
      status: "in_progress",
    },
  }
}

function functionCallArgumentsDone(
  input: {
    seq?: number
    outputIndex?: number
    itemId?: string
    name?: string
    args?: string
  } = {},
): SseChunk {
  return {
    type: "response.function_call_arguments.done",
    sequence_number: input.seq ?? 3,
    output_index: input.outputIndex ?? 0,
    item_id: input.itemId ?? "fc_1",
    name: input.name ?? "enter-worktree",
    arguments: input.args ?? "{}",
  }
}

function functionCallArgumentsDelta(input: {
  seq?: number
  outputIndex?: number
  itemId?: string
  delta: string
}): SseChunk {
  return {
    type: "response.function_call_arguments.delta",
    sequence_number: input.seq ?? 3,
    output_index: input.outputIndex ?? 0,
    item_id: input.itemId ?? "fc_1",
    delta: input.delta,
  }
}

function functionCallDone(
  input: {
    seq?: number
    outputIndex?: number
    itemId?: string
    callId?: string
    name?: string
    args?: string
  } = {},
): SseChunk {
  return {
    type: "response.output_item.done",
    sequence_number: input.seq ?? 4,
    output_index: input.outputIndex ?? 0,
    item: {
      type: "function_call",
      id: input.itemId ?? "fc_1",
      call_id: input.callId ?? "call_1",
      name: input.name ?? "enter-worktree",
      arguments: input.args ?? "{}",
      status: "completed",
    },
  }
}

function toolLifecycleParts(parts: LanguageModelV3StreamPart[]) {
  return parts.filter(
    (part) =>
      part.type === "tool-input-start" ||
      part.type === "tool-input-delta" ||
      part.type === "tool-input-end" ||
      part.type === "tool-call",
  )
}

function toolCalls(parts: LanguageModelV3StreamPart[]) {
  return parts.filter((part) => part.type === "tool-call")
}

function errors(parts: LanguageModelV3StreamPart[]) {
  return parts.filter((part) => part.type === "error")
}

function finish(parts: LanguageModelV3StreamPart[]) {
  return parts.find((part) => part.type === "finish")
}

describe("OpenAIResponsesLanguageModel function call materialization", () => {
  test("materializes no-arg client tool when arguments.done arrives without output_item.done", async () => {
    const parts = await streamParts([
      responseCreated(),
      functionCallAdded(),
      functionCallArgumentsDone({ args: "{}" }),
      responseCompleted(),
    ])

    expect(toolLifecycleParts(parts)).toMatchObject([
      { type: "tool-input-start", id: "call_1", toolName: "enter-worktree" },
      { type: "tool-input-end", id: "call_1" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "enter-worktree",
        input: "{}",
        providerMetadata: { openai: { itemId: "fc_1" } },
      },
    ])
    expect(toolCalls(parts)).toHaveLength(1)
  })

  test("uses final arguments.done input after argument deltas", async () => {
    const parts = await streamParts([
      responseCreated(),
      functionCallAdded(),
      functionCallArgumentsDelta({ seq: 3, delta: '{"path":' }),
      functionCallArgumentsDelta({ seq: 4, delta: '"draft"}' }),
      functionCallArgumentsDone({ seq: 5, args: '{"path":"final"}' }),
      responseCompleted(6),
    ])

    expect(toolCalls(parts)).toMatchObject([
      { type: "tool-call", toolCallId: "call_1", toolName: "enter-worktree", input: '{"path":"final"}' },
    ])
  })

  test("keeps output_item.done fallback when arguments.done is absent", async () => {
    const parts = await streamParts([
      responseCreated(),
      functionCallAdded(),
      functionCallArgumentsDelta({ seq: 3, delta: "{}" }),
      functionCallDone({ seq: 4, args: "{}" }),
      responseCompleted(5),
    ])

    expect(toolLifecycleParts(parts)).toMatchObject([
      { type: "tool-input-start", id: "call_1", toolName: "enter-worktree" },
      { type: "tool-input-delta", id: "call_1", delta: "{}" },
      { type: "tool-input-end", id: "call_1" },
      { type: "tool-call", toolCallId: "call_1", toolName: "enter-worktree", input: "{}" },
    ])
    expect(toolCalls(parts)).toHaveLength(1)
  })

  test("does not duplicate tool-call when arguments.done is followed by output_item.done", async () => {
    const parts = await streamParts([
      responseCreated(),
      functionCallAdded(),
      functionCallArgumentsDone({ seq: 3, args: "{}" }),
      functionCallDone({ seq: 4, args: "{}" }),
      responseCompleted(5),
    ])

    expect(toolCalls(parts)).toHaveLength(1)
    expect(toolCalls(parts)[0]).toMatchObject({ toolCallId: "call_1", input: "{}" })
  })

  test("blocks materialization when arguments.done name does not match added function name", async () => {
    const parts = await streamParts([
      responseCreated(),
      functionCallAdded({ name: "enter-worktree" }),
      functionCallArgumentsDone({ name: "bash", args: "{}" }),
      responseCompleted(),
    ])

    expect(toolCalls(parts)).toHaveLength(0)
    expect(errors(parts)).toHaveLength(1)
    expect(String((errors(parts)[0] as { error: unknown }).error)).toContain("function call name mismatch")
  })

  test("keeps error finish reason when response.completed follows a function call mismatch", async () => {
    const parts = await streamParts([
      responseCreated(),
      functionCallAdded({ name: "enter-worktree" }),
      functionCallArgumentsDone({ name: "bash", args: "{}" }),
      responseCompleted(),
    ])

    expect(errors(parts)).toHaveLength(1)
    expect(finish(parts)).toMatchObject({ finishReason: { unified: "error" } })
  })

  test("ignores late argument delta after materialization without changing input", async () => {
    const parts = await streamParts([
      responseCreated(),
      functionCallAdded(),
      functionCallArgumentsDone({ seq: 3, args: '{"path":"stable"}' }),
      functionCallArgumentsDelta({ seq: 4, delta: '{"path":"late"}' }),
      responseCompleted(5),
    ])

    expect(errors(parts)).toHaveLength(0)
    expect(toolCalls(parts)).toHaveLength(1)
    expect(toolCalls(parts)[0]).toMatchObject({ input: '{"path":"stable"}' })
  })

  test("emits an explicit error when response.failed arrives after function_call added", async () => {
    const parts = await streamParts([responseCreated(), functionCallAdded(), responseFailed()])

    expect(toolCalls(parts)).toHaveLength(0)
    expect(errors(parts).length).toBeGreaterThanOrEqual(1)
    expect(
      errors(parts).some((part) => String((part as { error: unknown }).error).includes("input did not complete")),
    ).toBe(true)
  })

  test("emits an explicit error on flush when function_call input never completes", async () => {
    const parts = await streamPartsWithoutDone([responseCreated(), functionCallAdded()])

    expect(toolCalls(parts)).toHaveLength(0)
    expect(errors(parts).length).toBeGreaterThanOrEqual(1)
    expect(
      errors(parts).some((part) => String((part as { error: unknown }).error).includes("input did not complete")),
    ).toBe(true)
  })
})
