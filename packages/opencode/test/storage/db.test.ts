import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "../../src/global"
import { Installation } from "../../src/installation"
import { Database } from "../../src/storage/db"

describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const expected = ["latest", "beta", "prod"].includes(Installation.CHANNEL)
      ? path.join(Global.Path.data, "opencode.db")
      : path.join(Global.Path.data, `opencode-${Installation.CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    expect(Database.getChannelPath()).toBe(expected)
  })

  test("uses PawWork database name when PawWork runtime namespace is enabled", () => {
    const previous = process.env.PAWWORK_RUNTIME_NAMESPACE
    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"

    try {
      const expected = ["latest", "beta", "prod"].includes(Installation.CHANNEL)
        ? path.join(Global.Path.data, "pawwork.db")
        : path.join(Global.Path.data, `pawwork-${Installation.CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
      expect(Database.getChannelPath()).toBe(expected)
    } finally {
      if (previous === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previous
    }
  })
})
