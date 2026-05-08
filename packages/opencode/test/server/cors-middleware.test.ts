import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Server } from "../../src/server/server"
import { Log } from "@opencode-ai/core/util/log"
import { Flag } from "@opencode-ai/core/flag/flag"
import { testEffect } from "../lib/effect"

Log.init({ print: false })

const it = testEffect(Layer.empty)
const mutableFlag = Flag as {
  OPENCODE_SERVER_PASSWORD?: string
  OPENCODE_SERVER_USERNAME?: string
}

const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

afterEach(() => {
  mutableFlag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  mutableFlag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
})

describe("CORS middleware", () => {
  it.live("allows localhost browser origins", () =>
    Effect.gen(function* () {
      const app = Server.Default().app
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app.request("/global/health", {
            headers: {
              Origin: "http://localhost:5173",
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
    }),
  )

  it.live("does not allow legacy Tauri origins", () =>
    Effect.gen(function* () {
      const app = Server.Default().app
      const origins = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]

      for (const origin of origins) {
        const response = yield* Effect.promise(() =>
          Promise.resolve(
            app.request("/global/health", {
              headers: {
                Origin: origin,
              },
            }),
          ),
        )

        expect(response.status).toBe(200)
        expect(response.headers.get("access-control-allow-origin")).toBeNull()
      }
    }),
  )

  it.live("adds CORS headers to unauthorized browser responses", () =>
    Effect.gen(function* () {
      mutableFlag.OPENCODE_SERVER_PASSWORD = "secret"
      mutableFlag.OPENCODE_SERVER_USERNAME = "alice"

      const app = Server.Default().app
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app.request("/global/health", {
            headers: {
              Origin: "https://app.opencode.ai",
            },
          }),
        ),
      )

      expect(response.status).toBe(401)
      expect(response.headers.get("access-control-allow-origin")).toBe("https://app.opencode.ai")
    }),
  )
})
