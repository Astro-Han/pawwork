import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { testEffect } from "../lib/effect"

Log.init({ print: false })

const it = testEffect(Layer.empty)

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
})
