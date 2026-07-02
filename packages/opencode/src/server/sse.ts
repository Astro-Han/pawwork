export type SsePacket = {
  id?: string
  data: string
}

type SseWriter = {
  write(packet: SsePacket): void
  close(): void
}

function formatPacket(packet: SsePacket) {
  const lines: string[] = []
  if (packet.id !== undefined) lines.push(`id: ${packet.id}`)
  for (const line of packet.data.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    lines.push(`data: ${line}`)
  }
  return `${lines.join("\n")}\n\n`
}

export function sseHeaders() {
  return new Headers({
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  })
}

export function createSseResponse(input: {
  signal?: AbortSignal | null
  start: (writer: SseWriter) => void | (() => void)
}) {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let cleanup: (() => void) | undefined
  let closed = false

  const finish = (closeController: boolean) => {
    if (closed) return
    closed = true
    input.signal?.removeEventListener("abort", abort)
    cleanup?.()
    if (!closeController) return
    try {
      controller?.close()
    } catch {
      // The stream may already be cancelled by the reader.
    }
  }
  const abort = () => finish(true)

  const body = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next
      input.signal?.addEventListener("abort", abort, { once: true })
      cleanup =
        input.start({
          write(packet) {
            if (closed) return
            next.enqueue(encoder.encode(formatPacket(packet)))
          },
          close() {
            finish(true)
          },
        }) ?? undefined
      if (input.signal?.aborted) finish(true)
    },
    cancel() {
      finish(false)
    },
  })

  return new Response(body, { headers: sseHeaders() })
}
