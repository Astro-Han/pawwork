import { Log } from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"

const log = Log.create({ service: "server" })

export function logHttpApiFailure(handler: "experimental" | "session", error: unknown) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://localhost")
    log.error("failed", {
      error,
      httpapi: handler,
      request: {
        method: request.method,
        path: url.pathname,
      },
    })
  })
}
