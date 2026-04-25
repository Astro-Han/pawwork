import { describe, expect, test } from "bun:test"
import yargs from "yargs/yargs"
import { ExportCommand } from "../../src/cli/cmd/export"
import { Export } from "../../src/session/export"
const { sanitize } = Export

describe("cli export command", () => {
  test("registers the sanitize option", () => {
    const parser = (ExportCommand.builder as (input: ReturnType<typeof yargs>) => ReturnType<typeof yargs>)(yargs([]))
    const optionKeys = Object.keys((parser as any).getOptions().key)

    expect(optionKeys).toContain("sanitize")
  })

  test("sanitizes assistant, retry, and tool error payloads", () => {
    const result = sanitize({
      info: {
        id: "session-1",
        title: "secret title",
        directory: "/tmp/secret",
        share: {
          url: "https://share.example/s/session-secret",
        },
      },
      messages: [
        {
          info: {
            id: "assistant-1",
            role: "assistant",
            path: {
              cwd: "/tmp/secret",
              root: "/repo/root",
            },
            structured: {
              secret: "raw structured output",
            },
            error: {
              name: "APIError",
              data: {
                message: "raw assistant error",
                isRetryable: true,
                responseBody: "{\"secret\":true}",
                responseHeaders: {
                  authorization: "Bearer secret",
                },
                metadata: {
                  requestId: "req_123",
                },
              },
            },
          },
          parts: [
            {
              id: "tool-1",
              type: "tool",
              tool: "bash",
              callID: "call-1",
              state: {
                status: "error",
                input: {
                  command: "cat ~/.env",
                },
                error: "raw tool stderr",
                metadata: {
                  commandId: "cmd-1",
                },
                time: {
                  start: 1,
                  end: 2,
                },
              },
            },
            {
              id: "retry-1",
              type: "retry",
              attempt: 2,
              error: {
                name: "APIError",
                data: {
                  message: "raw retry error",
                  isRetryable: true,
                  responseBody: "{\"secret\":true}",
                  responseHeaders: {
                    authorization: "Bearer secret",
                  },
                  metadata: {
                    requestId: "req_456",
                  },
                },
              },
              time: {
                created: 3,
              },
            },
          ],
        },
      ],
    } as any)

    const assistant = result.messages[0] as any
    const tool = assistant.parts[0]
    const retry = assistant.parts[1]

    expect(result.info.share).toEqual({ url: "[redacted:session-share:session-1]" })
    expect(assistant.info.structured).toEqual({ redacted: "assistant-structured:assistant-1" })
    expect(assistant.info.error.data.message).toBe("[redacted:assistant-error-message:assistant-1]")
    expect(assistant.info.error.data.responseBody).toBe("[redacted:assistant-error-body:assistant-1]")
    expect(assistant.info.error.data.responseHeaders).toEqual({ redacted: "assistant-error-headers:assistant-1" })
    expect(assistant.info.error.data.metadata).toEqual({ redacted: "assistant-error-metadata:assistant-1" })

    expect(tool.state.error).toBe("[redacted:tool-error:tool-1]")
    expect(retry.error.data.message).toBe("[redacted:retry-error-message:retry-1]")
    expect(retry.error.data.responseBody).toBe("[redacted:retry-error-body:retry-1]")
    expect(retry.error.data.responseHeaders).toEqual({ redacted: "retry-error-headers:retry-1" })
    expect(retry.error.data.metadata).toEqual({ redacted: "retry-error-metadata:retry-1" })
  })
})
