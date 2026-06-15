import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const shell = readFileSync(new URL("./settings-shell.tsx", import.meta.url), "utf8")
const remote = readFileSync(new URL("./remote.tsx", import.meta.url), "utf8")
const en = readFileSync(new URL("../../i18n/en.ts", import.meta.url), "utf8")
const zh = readFileSync(new URL("../../i18n/zh.ts", import.meta.url), "utf8")

describe("remote access settings source contract", () => {
  test("registers the Remote Access tab and page", () => {
    expect(shell).toContain('"remoteAccess"')
    expect(shell).toContain("RemotePage")
    expect(shell).toContain("settings.tab.remoteAccess")
  })

  test("includes localized remote access copy", () => {
    for (const key of [
      "settings.remote.description",
      "settings.remote.status.ready",
      "settings.remote.options.invalid",
      "settings.remote.action.failed",
      "settings.remote.action.start",
      "settings.remote.action.stop",
    ]) {
      expect(en).toContain(key)
      expect(zh).toContain(key)
    }
  })

  test("shows remote action failures", () => {
    expect(remote).toContain("remoteActionError")
    expect(remote).toContain("catch (error)")
    expect(remote).toContain("settings.remote.action.failed")
  })

  test("polls bridge status while it may be running", () => {
    expect(remote).toContain("REMOTE_ACCESS_STATUS_POLL_MS")
    expect(remote).toContain("setInterval")
    expect(remote).toContain("refetch()")
    expect(remote).toContain("mutate(next)")
    expect(remote).not.toContain("setLocalStatus")
  })
})
