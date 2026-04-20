import { describe, expect, test } from "bun:test"
import { performFatalExit } from "../../../src/cli/cmd/tui/component/error-component"

describe("performFatalExit", () => {
  test("still tears down and exits when onBeforeExit fails", async () => {
    const calls: string[] = []

    await expect(
      performFatalExit({
        onBeforeExit: async () => {
          calls.push("before")
          throw new Error("before failed")
        },
        onExit: async () => {
          calls.push("exit")
        },
        flushInput: () => {
          calls.push("flush")
        },
        renderer: {
          destroy: () => {
            calls.push("destroy")
          },
          setTerminalTitle: () => {
            calls.push("title")
          },
        },
      }),
    ).resolves.toBeUndefined()

    expect(calls).toEqual(["before", "title", "destroy", "flush", "exit"])
  })

  test("swallows exit errors from the fatal screen path", async () => {
    await expect(
      performFatalExit({
        onExit: async () => {
          throw new Error("exit failed")
        },
        renderer: {
          destroy: () => {},
          setTerminalTitle: () => {},
        },
      }),
    ).resolves.toBeUndefined()
  })
})
