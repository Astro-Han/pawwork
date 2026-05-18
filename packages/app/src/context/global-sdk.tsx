import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { batch, onCleanup, onMount } from "solid-js"
import type { E2EWindow } from "@/testing/terminal"
import { createSdkForServer } from "@/utils/server"
import { coalesceQueuedEvents, type QueuedGlobalEvent } from "./global-sdk-event-queue"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { useServer } from "./server"
import { createSseCursor } from "./global-sdk/sse-cursor"
import { createRecoverableSseDisconnectReporter } from "./global-sdk/sse-error"

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const language = useLanguage()
    const server = useServer()
    const platform = usePlatform()
    const abort = new AbortController()

    const eventFetch = (() => {
      if (!platform.fetch || !server.current) return
      try {
        const url = new URL(server.current.http.url)
        const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
        if (url.protocol === "http:" && !loopback) return platform.fetch
      } catch {
        return
      }
    })()

    const currentServer = server.current
    if (!currentServer) throw new Error(language.t("error.globalSDK.noServerAvailable"))

    const eventSdk = createSdkForServer({
      signal: abort.signal,
      fetch: eventFetch,
      server: currentServer.http,
    })
    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    const FLUSH_FRAME_MS = 16
    const STREAM_YIELD_MS = 8
    const RECONNECT_DELAY_MS = 250

    let queue: QueuedGlobalEvent[] = []
    let buffer: QueuedGlobalEvent[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined

      if (queue.length === 0) return

      const events = coalesceQueuedEvents(queue)
      queue = buffer
      buffer = events
      queue.length = 0

      last = Date.now()
      batch(() => {
        for (const event of events) {
          emitter.emit(event.directory, event.payload)
        }
      })

      buffer.length = 0
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
    }

    let streamErrorLogged = false
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const recoverableSseErrors = createRecoverableSseDisconnectReporter({ reportAfter: 3 })

    let attempt: AbortController | undefined
    let run: Promise<void> | undefined
    let started = false
    const HEARTBEAT_TIMEOUT_MS = 15_000
    let lastEventAt = Date.now()
    let heartbeat: ReturnType<typeof setTimeout> | undefined
    const replayCursor = createSseCursor()
    const resetHeartbeat = () => {
      lastEventAt = Date.now()
      if (heartbeat) clearTimeout(heartbeat)
      heartbeat = setTimeout(() => {
        attempt?.abort()
      }, HEARTBEAT_TIMEOUT_MS)
    }
    const clearHeartbeat = () => {
      if (!heartbeat) return
      clearTimeout(heartbeat)
      heartbeat = undefined
    }

    const start = () => {
      if (started) return run
      started = true
      run = (async () => {
        // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
        while (!abort.signal.aborted && started) {
          attempt = new AbortController()
          lastEventAt = Date.now()
          const onAbort = () => {
            attempt?.abort()
          }
          abort.signal.addEventListener("abort", onAbort)
          try {
            const events = await eventSdk.global.event({
              signal: attempt.signal,
              headers: replayCursor.headers(),
              onSseEvent: (event) => {
                replayCursor.update(event.id)
              },
              onSseError: (error) => {
                if (!recoverableSseErrors.shouldReport(error)) return
                if (streamErrorLogged) return
                streamErrorLogged = true
                console.error("[global-sdk] event stream error", {
                  url: currentServer.http.url,
                  fetch: eventFetch ? "platform" : "webview",
                  error,
                })
              },
            })
            let yielded = Date.now()
            resetHeartbeat()
            for await (const event of events.stream) {
              resetHeartbeat()
              recoverableSseErrors.reset()
              streamErrorLogged = false
              const directory = event.directory ?? "global"
              const payload = event.payload as Event | { type: "sync" }
              if (payload.type === "sync") {
                continue
              }
              queue.push({ directory, payload })
              schedule()

              if (Date.now() - yielded < STREAM_YIELD_MS) continue
              yielded = Date.now()
              await wait(0)
            }
          } catch (error) {
            if (recoverableSseErrors.shouldReport(error) && !streamErrorLogged) {
              streamErrorLogged = true
              console.error("[global-sdk] event stream failed", {
                url: currentServer.http.url,
                fetch: eventFetch ? "platform" : "webview",
                error,
              })
            }
          } finally {
            abort.signal.removeEventListener("abort", onAbort)
            attempt = undefined
            clearHeartbeat()
          }

          if (abort.signal.aborted || !started) return
          await wait(RECONNECT_DELAY_MS)
        }
      })().finally(() => {
        run = undefined
        flush()
      })
      return run
    }

    const stop = () => {
      started = false
      attempt?.abort()
      clearHeartbeat()
    }

    const e2e = () => {
      if (typeof window === "undefined") return
      const state = (window as E2EWindow).__opencode_e2e
      if (!state) return
      state.globalEventStream = {
        stop,
        start: () => {
          void start()
        },
        cursor: replayCursor.current,
        setCursorForTest: replayCursor.setCursorForTest,
      }
    }

    onMount(() => {
      e2e()
      makeEventListener(document, "visibilitychange", () => {
        if (document.visibilityState !== "visible") return
        if (!started) return
        if (Date.now() - lastEventAt < HEARTBEAT_TIMEOUT_MS) return
        attempt?.abort()
      })
    })

    onCleanup(() => {
      stop()
      abort.abort()
      flush()
    })

    const sdk = createSdkForServer({
      server: server.current.http,
      fetch: platform.fetch,
      throwOnError: true,
    })

    return {
      url: currentServer.http.url,
      client: sdk,
      event: {
        on: emitter.on.bind(emitter),
        listen: emitter.listen.bind(emitter),
        start,
      },
      createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
        const s = server.current
        if (!s) throw new Error(language.t("error.globalSDK.serverNotAvailable"))
        return createSdkForServer({
          server: s.http,
          fetch: platform.fetch,
          ...opts,
        })
      },
    }
  },
})
