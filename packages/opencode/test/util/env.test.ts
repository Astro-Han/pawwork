import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { bundledToolsDir, prependBundledTools, stripPathKeys, withoutInternalServerAuthEnv } from "../../src/util/env"

type ResourcesPathBag = { resourcesPath?: string }

function setResourcesPath(value: string | undefined) {
  const bag = process as unknown as ResourcesPathBag
  if (value === undefined) delete bag.resourcesPath
  else bag.resourcesPath = value
}

function getResourcesPath(): string | undefined {
  return (process as unknown as ResourcesPathBag).resourcesPath
}

describe("util.env", () => {
  test("does not mutate caller-owned env objects", () => {
    const env: Record<string, string> = {
      OPENCODE_SERVER_USERNAME: "PawWork",
      OPENCODE_SERVER_PASSWORD: "secret",
      PAWWORK_E2E_CUSTOM_ENV: "kept",
    }

    const sanitized = withoutInternalServerAuthEnv(env)

    expect(sanitized).toEqual({ PAWWORK_E2E_CUSTOM_ENV: "kept" })
    expect(env).toEqual({
      OPENCODE_SERVER_USERNAME: "PawWork",
      OPENCODE_SERVER_PASSWORD: "secret",
      PAWWORK_E2E_CUSTOM_ENV: "kept",
    })
    expect(sanitized).not.toBe(env)
  })

  test("removes internal auth keys regardless of case", () => {
    const env: Record<string, string> = {
      OpEnCoDe_Server_UserName: "PawWork",
      opencode_server_password: "secret",
      PAWWORK_E2E_CUSTOM_ENV: "kept",
    }

    const sanitized = withoutInternalServerAuthEnv(env)

    expect(sanitized).toEqual({ PAWWORK_E2E_CUSTOM_ENV: "kept" })
    expect(env).toEqual({
      OpEnCoDe_Server_UserName: "PawWork",
      opencode_server_password: "secret",
      PAWWORK_E2E_CUSTOM_ENV: "kept",
    })
    expect(sanitized).not.toBe(env)
  })
})

describe("util.env.bundledTools", () => {
  const original = getResourcesPath()
  afterEach(() => setResourcesPath(original))

  test("returns empty string when resourcesPath is unset (e.g. plain node/bun)", () => {
    setResourcesPath(undefined)
    expect(bundledToolsDir()).toBe("")
    expect(prependBundledTools("/usr/bin")).toBe("/usr/bin")
  })

  test("treats empty resourcesPath as unset so PATH is not poisoned with a relative 'tools'", () => {
    // path.join("", "tools") returns the relative string "tools"; if that
    // leaked into PATH, the shell would resolve `tools` against cwd. Guard.
    setResourcesPath("")
    expect(bundledToolsDir()).toBe("")
    expect(prependBundledTools("/usr/bin")).toBe("/usr/bin")
  })

  test("prepends bundled tools dir to PATH, preserving the rest", () => {
    setResourcesPath("/Applications/PawWork.app/Contents/Resources")
    const expectedDir = path.join("/Applications/PawWork.app/Contents/Resources", "tools")
    expect(bundledToolsDir()).toBe(expectedDir)
    expect(prependBundledTools("/usr/bin:/bin")).toBe(`${expectedDir}${path.delimiter}/usr/bin:/bin`)
  })

  test("prepend with empty currentPath returns bundled dir alone, never a trailing-delimiter PATH (cwd-shadowing guard)", () => {
    // POSIX treats an empty PATH segment (leading/trailing/double colon) as
    // the current directory, so emitting "/r/tools:" would let a malicious
    // file in cwd shadow officecli. The helper must drop the delimiter.
    setResourcesPath("/r")
    expect(prependBundledTools("")).toBe(path.join("/r", "tools"))
  })
})

describe("util.env.stripPathKeys", () => {
  test("removes every case-variant of PATH while leaving the rest untouched", () => {
    // Windows ships `Path`, some shells emit `path`, our code adds `PATH`.
    // After spreading process.env into a child env all three can co-exist,
    // and spawn forwards them with implementation-defined precedence.
    const env: Record<string, string | undefined> = {
      Path: "/system/path",
      PATH: "/our/override",
      path: "/lowercase",
      TERM: "xterm",
      OFFICECLI_SKIP_UPDATE: "1",
    }

    stripPathKeys(env)

    expect(env).toEqual({ TERM: "xterm", OFFICECLI_SKIP_UPDATE: "1" })
  })

  test("is safe on an env that has no path keys at all", () => {
    const env: Record<string, string | undefined> = { TERM: "xterm" }
    stripPathKeys(env)
    expect(env).toEqual({ TERM: "xterm" })
  })
})
