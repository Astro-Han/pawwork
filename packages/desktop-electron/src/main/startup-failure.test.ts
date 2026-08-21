import { describe, expect, test } from "vitest"
import { reportStartupFailure } from "./startup-failure"

const LOG_PATH = "/Users/pat/Library/Logs/PawWork/main.log"

// Reproduced from a real DSH exit: the sentence that says what to do is at the
// top, buried in frames, and repeated down the `[cause]` chain.
const CRASH_DUMP = `file:///app/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js:299
      throw new Error(\`failed to load plugin\`, { cause })
      ^

Error: failed to load plugin
    at updateError (file:///app/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js:299:9)
    at Entry._init (file:///app/node_modules/@deepseek-ai/cordis/lib/index.js:519:10) {
  [cause]: Error: credentials-local: /Users/pat/.credentials.yaml is readable beyond its owner (mode 644); run "chmod 600 /Users/pat/.credentials.yaml" before starting again
      at assertOwnerOnly (file:///app/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js:104:8)
}

Node.js v26.7.0`

function report(output: string, response = 0, locale: "en" | "zh" = "zh") {
  const seen: Array<Parameters<Parameters<typeof reportStartupFailure>[0]["showMessageBox"]>[0]> = []
  const opened: string[] = []
  const revealed: string[] = []
  const done = reportStartupFailure({
    locale,
    logPath: LOG_PATH,
    output,
    showMessageBox: async (options) => {
      seen.push(options)
      return { response }
    },
    openIssue: () => {
      opened.push("issue")
    },
    showItemInFolder: (path) => {
      revealed.push(path)
    },
  })
  return { done, content: () => seen[0], opened, revealed }
}

describe("DSH startup failure report", () => {
  // The dialog's whole job is to hand back the runtime's own words. Anything the
  // user cannot act on — the throw site, the frames, the Node version — is noise
  // that pushes the one actionable sentence off the screen.
  test("shows the innermost cause of a stack dump and nothing else from it", async () => {
    const { done, content } = report(CRASH_DUMP)
    await done

    expect(content().detail).toBe(
      `credentials-local: /Users/pat/.credentials.yaml is readable beyond its owner (mode 644); run "chmod 600 /Users/pat/.credentials.yaml" before starting again\n\n完整日志位于：\n${LOG_PATH}`,
    )
  })

  // Node labels its own failures with a code, and a plugin package that failed
  // to resolve is one of the failures most worth naming.
  test("reads through the bracketed code Node puts on its own errors", async () => {
    const { done, content } = report(
      [
        "node:internal/modules/esm/resolve:275",
        "  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base))",
        "",
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@pawwork/dsh-product' imported from /Users/pat/.pawwork/",
        "    at packageResolve (node:internal/modules/esm/resolve:275:9)",
      ].join("\n"),
    )
    await done

    expect(content().detail.split("\n\n")[0]).toBe(
      "Cannot find package '@pawwork/dsh-product' imported from /Users/pat/.pawwork/",
    )
  })

  test("still points at the log when the runtime said nothing recognisable", async () => {
    const { done, content } = report("dsh: starting\ndsh: loading plugins\n")
    await done

    expect(content().detail).toBe(`完整日志位于：\n${LOG_PATH}`)
  })

  // Return and Escape both resolve to this button, and it is the only one whose
  // meaning must survive a reorder: the other two act on the user's machine.
  test("defaults and cancels to quitting", async () => {
    const { done, content } = report("")
    await done

    expect(content().buttons[content().defaultId]).toBe("退出")
    expect(content().buttons[content().cancelId]).toBe("退出")
  })

  test("opens the issue tracker or reveals the log, matching the button pressed", async () => {
    const quit = report(CRASH_DUMP, 0)
    await quit.done
    expect([quit.opened, quit.revealed]).toEqual([[], []])
    expect(quit.content().buttons).toEqual(["退出", "反馈问题", "显示日志"])

    const issue = report(CRASH_DUMP, 1)
    await issue.done
    expect([issue.opened, issue.revealed]).toEqual([["issue"], []])

    const log = report(CRASH_DUMP, 2)
    await log.done
    expect([log.opened, log.revealed]).toEqual([[], [LOG_PATH]])
  })

  // The two locales are separate literals, so a swap inside one of them cannot
  // be caught by testing the other.
  test("keeps the button order in both locales", async () => {
    const en = report("", 0, "en")
    await en.done

    expect(en.content().buttons).toEqual(["Quit", "Report a Problem", "Show Log"])
    expect(en.content().detail).toBe(`The full log is at:\n${LOG_PATH}`)
  })

  test("truncates a runtime that puts a whole document on one line", async () => {
    const { done, content } = report(`Error: ${"x".repeat(900)}`)
    await done

    const [diagnosis] = content().detail.split("\n\n")
    expect(diagnosis).toHaveLength(401)
    expect(diagnosis.endsWith("…")).toBe(true)
  })
})
