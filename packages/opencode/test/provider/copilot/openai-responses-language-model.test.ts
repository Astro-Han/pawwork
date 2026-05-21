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

function toolLifecycleParts(parts: LanguageModelV3StreamPart[]) {
  return parts.filter(
    (part) => part.type === "tool-input-start" || part.type === "tool-input-end" || part.type === "tool-call",
  )
}

function toolCalls(parts: LanguageModelV3StreamPart[]) {
  return parts.filter((part) => part.type === "tool-call")
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
})
