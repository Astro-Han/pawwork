import { afterEach, expect, mock, test } from "bun:test"
import { CopilotModels } from "@/plugin/github-copilot/models"
import { CopilotAuthPlugin } from "@/plugin/github-copilot/copilot"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("preserves temperature support from existing provider models", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            {
              model_picker_enabled: true,
              id: "gpt-4o",
              name: "GPT-4o",
              version: "gpt-4o-2024-05-13",
              capabilities: {
                family: "gpt",
                limits: {
                  max_context_window_tokens: 64000,
                  max_output_tokens: 16384,
                  max_prompt_tokens: 64000,
                },
                supports: {
                  streaming: true,
                  tool_calls: true,
                },
              },
            },
            {
              model_picker_enabled: true,
              id: "brand-new",
              name: "Brand New",
              version: "brand-new-2026-04-01",
              capabilities: {
                family: "test",
                limits: {
                  max_context_window_tokens: 32000,
                  max_output_tokens: 8192,
                  max_prompt_tokens: 32000,
                },
                supports: {
                  streaming: true,
                  tool_calls: false,
                },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ),
  ) as unknown as typeof fetch

  const models = await CopilotModels.get(
    "https://api.githubcopilot.com",
    {},
    {
      "gpt-4o": {
        id: "gpt-4o",
        providerID: "github-copilot",
        api: {
          id: "gpt-4o",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/openai-compatible",
        },
        name: "GPT-4o",
        family: "gpt",
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: true,
          toolcall: true,
          input: {
            text: true,
            audio: false,
            image: true,
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
          context: 64000,
          output: 16384,
        },
        options: {},
        headers: {},
        release_date: "2024-05-13",
        variants: {},
        status: "active",
      },
    },
  )

  expect(models["gpt-4o"].capabilities.temperature).toBe(true)
  expect(models["brand-new"].capabilities.temperature).toBe(true)
})

test("remaps fallback oauth model urls to the enterprise host", async () => {
  globalThis.fetch = mock(() => Promise.reject(new Error("timeout"))) as unknown as typeof fetch

  const hooks = await CopilotAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const models = await hooks.provider!.models!(
    {
      id: "github-copilot",
      models: {
        claude: {
          id: "claude",
          providerID: "github-copilot",
          api: {
            id: "claude-sonnet-4.5",
            url: "https://api.githubcopilot.com/v1",
            npm: "@ai-sdk/anthropic",
          },
        },
      },
    } as never,
    {
      auth: {
        type: "oauth",
        refresh: "token",
        access: "token",
        expires: Date.now() + 60_000,
        enterpriseUrl: "ghe.example.com",
      } as never,
    },
  )

  expect(models.claude.api.url).toBe("https://copilot-api.ghe.example.com")
  expect(models.claude.api.npm).toBe("@ai-sdk/github-copilot")
})

test("disables anthropic tool streaming for github copilot chat params", async () => {
  const hooks = await CopilotAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const output = { temperature: 0, topP: 1, topK: 0, options: {} as Record<string, unknown> }
  await hooks["chat.params"]?.(
    {
      model: {
        providerID: "github-copilot",
        id: "claude",
        api: { id: "claude-sonnet-4.5", npm: "@ai-sdk/anthropic" },
      },
    } as never,
    output as never,
  )

  expect(output.options).toMatchObject({ toolStreaming: false })
})

test("keeps tool streaming untouched outside github copilot anthropic chat params", async () => {
  const hooks = await CopilotAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const copilotOpenAI = { temperature: 0, topP: 1, topK: 0, options: {} as Record<string, unknown> }
  await hooks["chat.params"]?.(
    {
      model: {
        providerID: "github-copilot",
        id: "gpt",
        api: { id: "gpt-5", npm: "@ai-sdk/openai" },
      },
    } as never,
    copilotOpenAI as never,
  )

  const anthropic = { temperature: 0, topP: 1, topK: 0, options: {} as Record<string, unknown> }
  await hooks["chat.params"]?.(
    {
      model: {
        providerID: "anthropic",
        id: "claude",
        api: { id: "claude-sonnet-4.5", npm: "@ai-sdk/anthropic" },
      },
    } as never,
    anthropic as never,
  )

  expect(copilotOpenAI.options).not.toHaveProperty("toolStreaming")
  expect(anthropic.options).not.toHaveProperty("toolStreaming")
})

test("sets anthropic beta header only for github copilot anthropic chat headers", async () => {
  const hooks = await CopilotAuthPlugin({
    client: {
      session: {
        message: async () => {
          throw new Error("skip")
        },
        get: async () => {
          throw new Error("skip")
        },
      },
    } as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const copilotAnthropic = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]?.(
    {
      model: {
        providerID: "github-copilot",
        id: "claude",
        api: { id: "claude-sonnet-4.5", npm: "@ai-sdk/anthropic" },
      },
      message: { sessionID: "s", id: "m" },
    } as never,
    copilotAnthropic as never,
  )

  const copilotOpenAI = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]?.(
    {
      model: {
        providerID: "github-copilot",
        id: "gpt",
        api: { id: "gpt-5", npm: "@ai-sdk/openai" },
      },
      message: { sessionID: "s", id: "m" },
    } as never,
    copilotOpenAI as never,
  )

  const anthropic = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]?.(
    {
      model: {
        providerID: "anthropic",
        id: "claude",
        api: { id: "claude-sonnet-4.5", npm: "@ai-sdk/anthropic" },
      },
      message: { sessionID: "s", id: "m" },
    } as never,
    anthropic as never,
  )

  expect(copilotAnthropic.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14")
  expect(copilotOpenAI.headers).not.toHaveProperty("anthropic-beta")
  expect(anthropic.headers).not.toHaveProperty("anthropic-beta")
})
