import { describe, expect, test } from "bun:test"
import type { ToolPart, ToolState } from "@opencode-ai/sdk/v2"
import type { UiI18n, UiI18nKey, UiI18nParams } from "../../context/i18n"
import { dict as en } from "../../i18n/en"
import { dict as zh } from "../../i18n/zh"
import { contextToolSummaryText, contextTrowSummaryText } from "./context-tool-helpers"

function resolveTemplate(text: string, params?: UiI18nParams) {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => {
    const value = params[String(rawKey)]
    return value === undefined ? "" : String(value)
  })
}

function i18n(locale: "en" | "zh"): UiI18n {
  return {
    locale: () => locale,
    t: (key: UiI18nKey, params?: UiI18nParams) => {
      const source = locale === "zh" ? (zh as Record<string, string>) : en
      return resolveTemplate(source[key] ?? en[key] ?? String(key), params)
    },
  }
}

function tool(
  id: string,
  name: string,
  status: "completed" | "error" = "completed",
  metadata: Record<string, unknown> = {},
  input: Record<string, unknown> = {},
  title = "",
): ToolPart {
  const state: ToolState =
    status === "error"
      ? { status, input, error: "boom", time: { start: 0, end: 1 } }
      : { status, input, output: "", title, metadata, time: { start: 0, end: 1 } }

  return {
    id,
    sessionID: "s",
    messageID: "m",
    type: "tool",
    callID: `call-${id}`,
    tool: name,
    state,
  }
}

describe("contextTrowSummaryText", () => {
  test("aggregates completed tool activity in first-seen category order", () => {
    const parts = [
      tool("read", "read"),
      tool("list", "list"),
      tool("bash", "bash"),
      tool("grep", "grep"),
      tool("websearch", "websearch"),
      tool("webfetch", "webfetch"),
      tool("edit", "edit"),
      tool("patch", "apply_patch", "completed", { files: [{}, {}] }),
      tool("skill", "skill"),
      tool("unknown", "linear_create_issue"),
    ]

    expect(contextTrowSummaryText(parts, 0, i18n("zh"))).toBe(
      "读取 2 个文件，运行 1 条命令，搜索文件 1 次，搜索网页 1 次，读取网页 1 个，修改 3 个文件，使用 2 个工具",
    )
  })

  test("keeps failures as a trailing summary item", () => {
    expect(contextTrowSummaryText([tool("bash", "bash", "error")], 1, i18n("zh"))).toBe(
      "运行 1 条命令，1 个失败",
    )
  })

  test("uses English singular labels when the count is one", () => {
    const parts = [tool("read", "read"), tool("bash", "bash"), tool("skill", "skill")]

    expect(contextTrowSummaryText(parts, 0, i18n("en"))).toBe("Read 1 file, Ran 1 command, Used 1 tool")
  })

  test("keeps a completed apply_patch tool summary on one line", () => {
    const part = tool(
      "patch",
      "apply_patch",
      "completed",
      {
        files: [
          {
            type: "update",
            filePath: "/repo/packages/app/src/pages/session/session-timeline-scroll-controller.test.ts",
            relativePath: "packages/app/src/pages/session/session-timeline-scroll-controller.test.ts",
            patch: "@@ -1 +1 @@\n-old\n+new\n",
          },
        ],
      },
      {},
      "Success. Updated the following files:\nM packages/app/src/pages/session/session-timeline-scroll-controller.test.ts",
    )

    const summary = contextToolSummaryText(part, i18n("en"))

    expect(summary).toBe("Edit files 1 file")
    expect(summary).not.toContain("\n")
  })
})
