import { describe, expect, test } from "bun:test"
import { directoryEventTargets } from "./event-routing"

describe("global sync event routing", () => {
  test("mirrors root-owned session updates from active worktree events to the owner directory", () => {
    const event = {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_1",
          directory: "/repo",
          executionContext: {
            ownerDirectory: "/repo",
            activeDirectory: "/repo",
          },
        },
      },
    }

    const targets = directoryEventTargets({
      directory: "/repo/.worktrees/pawwork/fix-titlebar",
      event,
      hasChild: (directory) => directory === "/repo",
    })

    expect(targets).toEqual(["/repo/.worktrees/pawwork/fix-titlebar", "/repo"])
  })
})
