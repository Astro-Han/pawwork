import { describe, expect, test } from "bun:test"
import { redactProxyURL } from "../../src/server/proxy"

describe("server proxy logging", () => {
  test("redacts sensitive websocket query credentials", () => {
    const request = redactProxyURL(
      "http://127.0.0.1:4096/pty/pty_test/connect?ticket=connect-ticket&auth_token=basic-token&cursor=12",
    )
    const target = redactProxyURL(
      "ws://remote.example/pty/pty_test/connect?ticket=remote-ticket&auth_token=remote-token&cursor=12",
    )

    expect(request).toBe(
      "http://127.0.0.1:4096/pty/pty_test/connect?ticket=REDACTED&auth_token=REDACTED&cursor=12",
    )
    expect(target).toBe(
      "ws://remote.example/pty/pty_test/connect?ticket=REDACTED&auth_token=REDACTED&cursor=12",
    )
    expect(request).not.toContain("connect-ticket")
    expect(request).not.toContain("basic-token")
    expect(target).not.toContain("remote-ticket")
    expect(target).not.toContain("remote-token")
  })
})
