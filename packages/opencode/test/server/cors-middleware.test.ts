import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("CORS middleware", () => {
  test("allows localhost browser origins", async () => {
    const app = Server.Default().app
    const response = await app.request("/global/health", {
      headers: {
        Origin: "http://localhost:5173",
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
  })

  test("does not allow legacy Tauri origins", async () => {
    const app = Server.Default().app
    const origins = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]

    for (const origin of origins) {
      const response = await app.request("/global/health", {
        headers: {
          Origin: origin,
        },
      })

      expect(response.status).toBe(200)
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
    }
  })
})
