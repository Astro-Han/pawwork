import { raw } from "../../../opencode/test/lib/llm-server"

export const CONCURRENT_SHIMMER_COUNT = 40

const TOOL_TITLES = [
  "读文件",
  "Read file",
  "运行测试套件",
  "Run test suite",
  "扫描 384 个文件",
  "Scan 384 files",
  "构建 desktop bundle",
  "Build desktop bundle",
  "改 session.tsx",
  "Edit session.tsx",
] as const

function chatChunk(delta: Record<string, unknown>) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ delta }],
  }
}

/**
 * Build a single hanging assistant response containing N parallel pending
 * `bash` tool calls — each with its own tool_call `index`, otherwise the
 * agent treats them as updates to one tool and only renders one trow. The
 * SSE connection hangs (no finish_reason) so every tool stays in pending
 * state, rendering N concurrent shimmer instances.
 */
export function buildConcurrentShimmerReply(count: number) {
  const chunks: unknown[] = [chatChunk({ role: "assistant" })]
  for (let index = 0; index < count; index += 1) {
    const id = `call_${index}`
    const title = TOOL_TITLES[index % TOOL_TITLES.length]
    const args = JSON.stringify({
      command: "sleep 9999",
      description: `${title} #${index}`,
    })
    chunks.push(
      chatChunk({
        tool_calls: [
          {
            index,
            id,
            type: "function",
            function: { name: "bash", arguments: "" },
          },
        ],
      }),
    )
    chunks.push(
      chatChunk({
        tool_calls: [
          {
            index,
            function: { arguments: args },
          },
        ],
      }),
    )
  }
  return raw({ chunks, hang: true })
}
