import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { Permission } from "../../src/permission"
import {
  TOOL_FAILURE_HINTS,
  classifyToolFailure,
  formatToolFailureForModel,
  safeToolFailureMetadata,
} from "../../src/session/tool-failure"

describe("tool failure classification", () => {
  test("classifies the initial failure kinds", () => {
    const cases = [
      {
        name: "invalid tool arguments",
        error: new Error("The read tool was called with invalid arguments: missing filePath."),
        errorKind: "invalid_arguments",
      },
      {
        name: "permission denied by PawWork",
        error: new Permission.DeniedError({ ruleset: [{ permission: "bash", pattern: "rm *", action: "deny" }] }),
        errorKind: "permission_denied",
      },
      {
        name: "environment path missing",
        error: Object.assign(new Error("ENOENT: no such file or directory, open '/tmp/missing'"), {
          code: "ENOENT",
        }),
        errorKind: "environment",
      },
      {
        name: "provider api failure",
        error: new APICallError({
          message: "Rate limit exceeded",
          url: "https://provider.example/v1/messages",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: {},
          isRetryable: true,
        }),
        errorKind: "provider",
      },
      {
        name: "tool timeout",
        error: Object.assign(new Error("Tool execution timed out after 1000ms"), { name: "TimeoutError" }),
        errorKind: "timeout",
      },
      {
        name: "unknown fallback",
        error: new Error("something unexpected happened"),
        errorKind: "unknown",
      },
    ] as const

    for (const item of cases) {
      expect(classifyToolFailure({ tool: "bash", error: item.error }), item.name).toEqual({
        errorKind: item.errorKind,
        recoveryHint: TOOL_FAILURE_HINTS[item.errorKind],
      })
    }
  })

  test("formats model-facing failures with the original error and concise hint", () => {
    const text = formatToolFailureForModel("raw failure", {
      errorKind: "invalid_arguments",
      recoveryHint: TOOL_FAILURE_HINTS.invalid_arguments,
    })

    expect(text).toContain("raw failure")
    expect(text).toContain("invalid_arguments")
    expect(text).toContain(TOOL_FAILURE_HINTS.invalid_arguments)
  })

  test("sanitizes stored failure metadata to canonical safe fields", () => {
    expect(
      safeToolFailureMetadata({
        errorKind: "environment",
        recoveryHint: "check /Users/alice/.env",
        extra: "raw secret",
      }),
    ).toEqual({
      errorKind: "environment",
      recoveryHint: TOOL_FAILURE_HINTS.environment,
    })

    expect(safeToolFailureMetadata({ errorKind: "not_real", recoveryHint: "retry" })).toBeUndefined()
  })
})
