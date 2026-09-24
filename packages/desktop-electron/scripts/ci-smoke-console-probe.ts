import { spawn } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { join, resolve } from "node:path"

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export const CONSOLE_PROBE_PROVIDER = "pawwork-console-probe"
export const CONSOLE_PROBE_MODEL = "console-probe"
export const CONSOLE_PROBE_MARKER = "pawwork-console-probe-42"
// Long enough for the window watcher to sample the command while it runs.
const CONSOLE_PROBE_COMMAND = "Start-Sleep -Seconds 3; Write-Output ('pawwork-console-probe-' + (40 + 2))"

type ChatMessage = { role?: unknown; content?: unknown }
type ChatRequest = { messages?: ChatMessage[]; tools?: Array<{ function?: { name?: unknown } }> }

export type FakeToolModel = {
  baseURL: string
  toolResult: Promise<string>
  close(): Promise<void>
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
  return ""
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest
}

function reply(response: ServerResponse, delta: Record<string, unknown>, finishReason: string) {
  const base = { id: "chatcmpl-probe", created: 0, model: CONSOLE_PROBE_MODEL }
  const chunk = (body: unknown) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...(body as object) })}\n\n`
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  response.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] }))
  response.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }))
  response.write(chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  response.end("data: [DONE]\n\n")
}

/**
 * An OpenAI-compatible streaming endpoint that answers the agent's turn with
 * one pwsh call and resolves `toolResult` with the tool message sent back.
 */
export async function startFakeToolModel(): Promise<FakeToolModel> {
  const toolName = "pwsh"
  let resolveResult!: (text: string) => void
  let rejectResult!: (error: Error) => void
  const toolResult = new Promise<string>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  toolResult.catch(() => undefined)

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
        response.writeHead(404).end()
        return
      }
      const body = await readJson(request)
      const tools = (body.tools ?? []).map((tool) => tool.function?.name).filter((name): name is string => typeof name === "string")
      const toolMessage = body.messages?.find((message) => message.role === "tool")
      if (toolMessage !== undefined) {
        resolveResult(textOf(toolMessage.content))
        reply(response, { content: "done" }, "stop")
        return
      }
      // Requests without tools are side calls such as title generation.
      if (tools.length === 0) {
        reply(response, { content: "Console probe" }, "stop")
        return
      }
      if (!tools.includes(toolName)) {
        rejectResult(new Error(`the agent offered no ${toolName} tool; offered: ${tools.join(", ")}`))
        reply(response, { content: "no tool" }, "stop")
        return
      }
      const call = { index: 0, id: "call_console_probe", type: "function", function: { name: toolName, arguments: JSON.stringify({ command: CONSOLE_PROBE_COMMAND, description: "Console window probe" }) } }
      reply(response, { content: null, tool_calls: [call] }, "tool_calls")
    })().catch((error: unknown) => {
      rejectResult(error instanceof Error ? error : new Error(String(error)))
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    toolResult,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export type ConsoleWatchEvent = {
  kind: "window" | "process"
  handle?: number
  className?: string
  visible?: boolean
  processId: number
  processName?: string
  name?: string
  parentProcessId?: number
  parentName?: string
  commandLine?: string
}

/** Watches for new top-level windows and console processes until stopped. Windows only. */
export async function startConsoleWatch(directory: string) {
  const output = join(directory, "console-watch.jsonl")
  const stopFile = join(directory, "console-watch.stop")
  rmSync(stopFile, { force: true })
  const script = resolve(import.meta.dirname, "watch-console-windows.ps1")
  const watcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-OutputPath", output, "-StopPath", stopFile], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  })
  let stderr = ""
  watcher.stderr.on("data", (chunk) => (stderr += chunk))
  const exited = new Promise<void>((resolve) => watcher.once("exit", () => resolve()))
  const deadline = Date.now() + 30_000
  while (!(existsSync(output) && readFileSync(output, "utf8").includes('"ready"'))) {
    if (watcher.exitCode !== null || Date.now() > deadline) throw new Error(`console window watcher did not start: ${stderr.trim()}`)
    await delay(100)
  }
  return {
    async stop(): Promise<ConsoleWatchEvent[]> {
      // Let a window that opens as the command exits reach one more sample.
      await delay(1_000)
      if (watcher.exitCode !== null) throw new Error(`console window watcher stopped sampling early (exit ${watcher.exitCode}): ${stderr.trim()}`)
      writeFileSync(stopFile, "")
      await Promise.race([exited, delay(10_000)])
      if (watcher.exitCode === null) watcher.kill()
      return readFileSync(output, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ConsoleWatchEvent & { kind: string })
        .filter((event): event is ConsoleWatchEvent => event.kind === "window" || event.kind === "process")
    },
  }
}

const CONSOLE_WINDOW_CLASSES = new Set(["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "PseudoConsoleWindow"])

// DSH creates each command's console hidden, which also keeps Windows Terminal
// from taking it over, so only a visible console window is a failure.
export function assertNoVisibleConsoleWindows(events: ConsoleWatchEvent[], toolResult: string) {
  const describe = (event: ConsoleWatchEvent) => JSON.stringify(event)
  const failures: string[] = []
  if (!toolResult.includes(CONSOLE_PROBE_MARKER)) failures.push(`the pwsh tool did not run the probe command; tool result: ${toolResult.slice(0, 500)}`)
  const shells = events.filter((event) => event.kind === "process" && /^(pwsh|powershell)\.exe$/i.test(event.name ?? "") && event.commandLine?.includes("pawwork-console-probe"))
  if (shells.length === 0) failures.push("the watcher never saw the probe's pwsh process, so its window census cannot be trusted")
  const consoles = events.filter((event) => event.kind === "window" && event.visible === true && CONSOLE_WINDOW_CLASSES.has(event.className ?? ""))
    .filter((event, index, all) => all.findIndex((other) => other.handle === event.handle) === index)
  if (consoles.length > 0) failures.push(`running a pwsh tool command showed console windows:\n  ${consoles.map(describe).join("\n  ")}`)
  if (failures.length > 0) {
    throw new Error(`Windows console probe failed:\n- ${failures.join("\n- ")}\nwatch events:\n  ${events.map(describe).join("\n  ")}`)
  }
}
