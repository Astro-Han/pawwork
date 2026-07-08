import { describe, expect, test } from "bun:test"
import { createWorkspaceProxyPeer, protocols, redactProxyURL } from "../../src/server/proxy"

class FakeRemoteSocket {
  static readonly OPEN = WebSocket.OPEN
  binaryType: BinaryType = "blob"
  readyState = 0
  sent: unknown[] = []
  closed: Array<{ code?: number; reason?: string }> = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null

  send(data: unknown) {
    this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    this.closed.push({ code, reason })
  }
}

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

describe("workspace websocket proxy boundary", () => {
  test("parses requested websocket subprotocols", () => {
    const request = new Request("http://localhost", {
      headers: { "sec-websocket-protocol": "pawwork, remote-sync , ," },
    })

    expect(protocols(request)).toEqual(["pawwork", "remote-sync"])
  })

  test("closes the local socket when the proxy target is missing", () => {
    const closed: Array<{ code?: number; reason?: string }> = []
    const peer = createWorkspaceProxyPeer({})

    peer.onOpen({ send: () => {}, close: (code, reason) => closed.push({ code, reason }) })

    expect(closed).toEqual([{ code: 1011, reason: "missing proxy target" }])
  })

  test("queues local messages until the remote websocket opens", () => {
    let remote: FakeRemoteSocket | undefined
    const localSent: unknown[] = []
    const localClosed: Array<{ code?: number; reason?: string }> = []
    const peer = createWorkspaceProxyPeer({
      targetUrl: "ws://remote.example/session",
      protocols: ["pawwork"],
      socketFactory: () => {
        remote = new FakeRemoteSocket()
        return remote as any
      },
    })

    peer.onMessage("queued-before-open")
    peer.onOpen({
      send: (data) => localSent.push(data),
      close: (code, reason) => localClosed.push({ code, reason }),
    })
    expect(remote?.binaryType).toBe("arraybuffer")
    expect(remote?.sent).toEqual([])

    remote!.readyState = WebSocket.OPEN
    remote!.onopen?.()
    peer.onMessage("after-open")
    remote!.onmessage?.({ data: "from-remote" })
    remote!.onclose?.({ code: 1000, reason: "done" })

    expect(remote?.sent).toEqual(["queued-before-open", "after-open"])
    expect(localSent).toEqual(["from-remote"])
    expect(localClosed).toEqual([{ code: 1000, reason: "done" }])
  })

})
