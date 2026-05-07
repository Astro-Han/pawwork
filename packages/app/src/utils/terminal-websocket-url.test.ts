import { describe, expect, test } from "bun:test"
import { terminalWebSocketURL } from "./terminal-websocket-url"

describe("terminalWebSocketURL", () => {
  test("uses query auth for non-same-origin saved credentials", () => {
    const url = terminalWebSocketURL({
      url: "https://server.example.test",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 10,
      sameOrigin: false,
      username: "opencode",
      password: "secret",
    })

    expect(url.protocol).toBe("wss:")
    expect(url.pathname).toBe("/pty/pty_test/connect")
    expect(url.searchParams.get("directory")).toBe("/tmp/project")
    expect(url.searchParams.get("cursor")).toBe("10")
    expect(url.searchParams.get("auth_token")).toBe(btoa("opencode:secret"))
  })

  test("omits query auth for same-origin saved credentials", () => {
    const url = terminalWebSocketURL({
      url: "https://app.example.test",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 10,
      sameOrigin: true,
      username: "opencode",
      password: "secret",
    })

    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.has("auth_token")).toBe(false)
  })

  test("uses query auth for same-origin credentials from auth_token", () => {
    const url = terminalWebSocketURL({
      url: "https://app.example.test",
      id: "pty_test",
      directory: "/tmp/project",
      cursor: 10,
      sameOrigin: true,
      username: "opencode",
      password: "secret",
      authToken: true,
    })

    expect(url.protocol).toBe("wss:")
    expect(url.searchParams.get("auth_token")).toBe(btoa("opencode:secret"))
  })
})
