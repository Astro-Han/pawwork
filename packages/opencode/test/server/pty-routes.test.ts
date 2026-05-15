import { describe, expect, test } from "bun:test"
import { assertPtyConnectTarget } from "../../src/server/instance/pty"
import { NotFoundError } from "../../src/storage/db"

describe("pty routes", () => {
  test("reports missing websocket connect targets as not found", () => {
    expect(() => assertPtyConnectTarget(undefined)).toThrow(NotFoundError)
  })

  test("accepts existing websocket connect targets", () => {
    expect(() => assertPtyConnectTarget({ id: "pty_present" })).not.toThrow()
  })
})
