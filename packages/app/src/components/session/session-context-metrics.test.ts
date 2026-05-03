import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { getSessionContextMetrics } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { total?: number; input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: {
      total: tokens.total,
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    cost: 0,
    time: { created: 1 },
  } as unknown as Message
}

describe("getSessionContextMetrics", () => {
  test("computes totals and usage from latest assistant with tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000, output: 100 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.totalCost).toBe(1.75)
    expect(metrics.context?.message.id).toBe("a2")
    expect(metrics.context?.total).toBe(450)
    expect(metrics.context?.usedTokens).toBe(450)
    expect(metrics.context?.effectiveInputLimit).toBe(1000)
    expect(metrics.context?.compactThreshold).toBe(900)
    expect(metrics.context?.usage).toBe(45)
    expect(metrics.context?.providerLabel).toBe("OpenAI")
    expect(metrics.context?.modelLabel).toBe("GPT-4.1")
  })

  test("uses input limit and custom compaction reserve for usage metrics", () => {
    const messages = [assistant("a1", { total: 238_000, input: 1, output: 1, reasoning: 1, read: 1, write: 1 }, 1)]
    const providers = [
      {
        id: "openai",
        models: {
          "gpt-4.1": {
            limit: { context: 400_000, input: 272_000, output: 128_000 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers, { compaction: { reserved: 20_000 } })

    expect(metrics.context?.limit).toBe(272_000)
    expect(metrics.context?.contextWindow).toBe(400_000)
    expect(metrics.context?.usedTokens).toBe(238_000)
    expect(metrics.context?.compactThreshold).toBe(252_000)
    expect(metrics.context?.usage).toBe(Math.round((238_000 / 272_000) * 100))
  })

  test("selects the latest assistant when only total tokens are reported", () => {
    const messages = [
      assistant("a1", { input: 10, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1),
      assistant("a2", { total: 70_000, input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0.2),
    ]
    const providers = [
      {
        id: "openai",
        models: {
          "gpt-4.1": {
            limit: { context: 100_000, output: 10_000 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.message.id).toBe("a2")
    expect(metrics.context?.usedTokens).toBe(70_000)
  })

  test("treats zero context limit as unknown", () => {
    const messages = [assistant("a1", { total: 20_000, input: 1, output: 1, reasoning: 1, read: 1, write: 1 }, 1)]
    const providers = [
      {
        id: "openai",
        models: {
          "gpt-4.1": {
            limit: { context: 0, output: 0 },
          },
        },
      },
    ]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.usedTokens).toBe(20_000)
    expect(metrics.context?.limit).toBeUndefined()
    expect(metrics.context?.compactThreshold).toBeUndefined()
    expect(metrics.context?.usage).toBeNull()
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1", models: {} }]

    const metrics = getSessionContextMetrics(messages, providers)

    expect(metrics.context?.providerLabel).toBe("p-1")
    expect(metrics.context?.modelLabel).toBe("m-1")
    expect(metrics.context?.limit).toBeUndefined()
    expect(metrics.context?.compactThreshold).toBeUndefined()
    expect(metrics.context?.usage).toBeNull()
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContextMetrics(messages, providers)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContextMetrics(messages, providers)

    expect(one.context?.message.id).toBe("a1")
    expect(two.context?.message.id).toBe("a2")
    expect(two.totalCost).toBe(1)
  })

  test("returns empty metrics when inputs are undefined", () => {
    const metrics = getSessionContextMetrics(undefined, undefined)

    expect(metrics.totalCost).toBe(0)
    expect(metrics.context).toBeUndefined()
  })
})
