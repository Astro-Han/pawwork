import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { Readable } from "node:stream"
import { Auth } from "../../src/auth"
import { ProvidersLoginCommand } from "../../src/cli/cmd/providers"
import { Instance } from "../../src/project/instance"
import { Process } from "../../src/util/process"

const originalFetch = globalThis.fetch
const loginUrl = "https://enterprise-auth.test"

afterEach(async () => {
  globalThis.fetch = originalFetch
  mock.restore()
  await Auth.remove(loginUrl).catch(() => {})
})

test("url login skips instance bootstrap so stale remote config cannot block re-auth", async () => {
  const provide = spyOn(Instance, "provide").mockImplementation(() => {
    throw new Error("stale remote config")
  })
  const spawn = spyOn(Process, "spawn").mockReturnValue({
    stdout: undefined,
    stderr: undefined,
    exited: Promise.resolve(1),
  } as never)
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : url instanceof URL ? url.href : url
    expect(urlStr).toBe(`${loginUrl}/.well-known/opencode`)
    return Promise.resolve(
      new Response(JSON.stringify({ auth: { command: ["sh", "-c", "printf token"], env: "TEST_TOKEN" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  }) as unknown as typeof fetch

  await ProvidersLoginCommand.handler({ url: loginUrl } as never)

  expect(provide).not.toHaveBeenCalled()
  expect(spawn).toHaveBeenCalledWith(["sh", "-c", "printf token"], {
    stdout: "pipe",
    stderr: "inherit",
  })
})

test("url login stores the refreshed well-known credential outside instance bootstrap", async () => {
  const provide = spyOn(Instance, "provide").mockImplementation(() => {
    throw new Error("stale remote config")
  })
  spyOn(Process, "spawn").mockReturnValue({
    stdout: Readable.from([" fresh-token\n"]),
    stderr: undefined,
    exited: Promise.resolve(0),
  } as never)
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : url instanceof URL ? url.href : url
    expect(urlStr).toBe(`${loginUrl}/.well-known/opencode`)
    return Promise.resolve(
      new Response(JSON.stringify({ auth: { command: ["sh", "-c", "printf token"], env: "TEST_TOKEN" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  }) as unknown as typeof fetch

  await ProvidersLoginCommand.handler({ url: `${loginUrl}/` } as never)

  expect(provide).not.toHaveBeenCalled()
  expect(await Auth.get(loginUrl)).toEqual({
    type: "wellknown",
    key: "TEST_TOKEN",
    token: "fresh-token",
  })
})

test("url login rejects non-json auth metadata with a clear error", async () => {
  const spawn = spyOn(Process, "spawn")
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : url instanceof URL ? url.href : url
    expect(urlStr).toBe(`${loginUrl}/.well-known/opencode`)
    return Promise.resolve(
      new Response("<!doctype html><html><body>Login required</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    )
  }) as unknown as typeof fetch

  await expect(ProvidersLoginCommand.handler({ url: loginUrl } as never)).rejects.toThrow(
    "the server returned a login page instead of JSON",
  )

  expect(spawn).not.toHaveBeenCalled()
})

test("url login rejects invalid auth provider urls before fetching metadata", async () => {
  const spawn = spyOn(Process, "spawn")
  await expect(ProvidersLoginCommand.handler({ url: "enterprise-auth.test" } as never)).rejects.toThrow(
    "The URL must start with http:// or https://",
  )
  expect(spawn).not.toHaveBeenCalled()
})

test("url login rejects network errors with a clear metadata error", async () => {
  const spawn = spyOn(Process, "spawn")
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : url instanceof URL ? url.href : url
    expect(urlStr).toBe(`${loginUrl}/.well-known/opencode`)
    return Promise.reject(new TypeError("fetch failed"))
  }) as unknown as typeof fetch

  await expect(ProvidersLoginCommand.handler({ url: loginUrl } as never)).rejects.toThrow(
    `Failed to connect to ${loginUrl}/.well-known/opencode: fetch failed`,
  )
  expect(spawn).not.toHaveBeenCalled()
})

test("url login rejects non-ok auth metadata with a clear error", async () => {
  const spawn = spyOn(Process, "spawn")
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : url instanceof URL ? url.href : url
    expect(urlStr).toBe(`${loginUrl}/.well-known/opencode`)
    return Promise.resolve(new Response("Server error", { status: 500 }))
  }) as unknown as typeof fetch

  await expect(ProvidersLoginCommand.handler({ url: loginUrl } as never)).rejects.toThrow("the server returned HTTP 500")

  expect(spawn).not.toHaveBeenCalled()
})

test("url login rejects invalid auth metadata with a clear error", async () => {
  const spawn = spyOn(Process, "spawn")
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : url instanceof URL ? url.href : url
    expect(urlStr).toBe(`${loginUrl}/.well-known/opencode`)
    return Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  }) as unknown as typeof fetch

  await expect(ProvidersLoginCommand.handler({ url: loginUrl } as never)).rejects.toThrow(
    "the response did not include a valid auth command",
  )

  expect(spawn).not.toHaveBeenCalled()
})

test("url login rejects empty auth commands as invalid metadata", async () => {
  const spawn = spyOn(Process, "spawn")
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : url instanceof URL ? url.href : url
    expect(urlStr).toBe(`${loginUrl}/.well-known/opencode`)
    return Promise.resolve(
      new Response(JSON.stringify({ auth: { command: [], env: "TEST_TOKEN" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  }) as unknown as typeof fetch

  await expect(ProvidersLoginCommand.handler({ url: loginUrl } as never)).rejects.toThrow(
    "the response did not include a valid auth command",
  )
  expect(spawn).not.toHaveBeenCalled()
})

test("url login rejects auth command failures with a clear error", async () => {
  spyOn(Process, "spawn").mockReturnValue({
    stdout: Readable.from([""]),
    stderr: undefined,
    exited: Promise.reject(new Error("spawn missing")),
  } as never)
  globalThis.fetch = mock((url: string | URL | Request) => {
    const urlStr = url instanceof Request ? url.url : url instanceof URL ? url.href : url
    expect(urlStr).toBe(`${loginUrl}/.well-known/opencode`)
    return Promise.resolve(
      new Response(JSON.stringify({ auth: { command: ["missing-auth"], env: "TEST_TOKEN" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  }) as unknown as typeof fetch

  await expect(ProvidersLoginCommand.handler({ url: loginUrl } as never)).rejects.toThrow(
    "Failed to run auth command: spawn missing",
  )
})
