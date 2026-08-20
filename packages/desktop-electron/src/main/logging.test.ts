import { afterEach, describe, expect, test, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

let logDir = ""
const { fakeLog } = vi.hoisted(() => ({ fakeLog: {
  transports: {
    file: {
      maxSize: 0,
      getFile: () => ({ path: "/tmp/desktop.log" }),
    },
    console: {
      level: "info" as string | false,
      // electron-log hands the console transport a message payload; the fake
      // has to accept it or setupLog cannot install a spying writeFn.
      writeFn: (_options: unknown): void => undefined,
    },
  },
} }))

vi.mock("electron-log/main.js", () => ({
  default: fakeLog,
}))

import { initLogging } from "./logging"

afterEach(() => {
  if (logDir) rmSync(logDir, { recursive: true, force: true })
  logDir = ""
})

function setupLog(writeFn: (options: unknown) => void) {
  logDir = mkdtempSync(join(tmpdir(), "pawwork-logging-test-"))
  fakeLog.transports.file = {
    maxSize: 0,
    getFile: () => ({ path: join(logDir, "desktop.log") }),
  }
  fakeLog.transports.console = {
    level: "info",
    writeFn,
  }
  return fakeLog.transports.console
}

function brokenPipe() {
  return Object.assign(new Error("broken pipe"), { code: "EPIPE" })
}

function otherWriteError() {
  return Object.assign(new Error("write failed"), { code: "ENOENT" })
}

describe("desktop logging", () => {
  test("disables the console transport after a broken pipe", async () => {
    const consoleTransport = setupLog(() => {
      throw brokenPipe()
    })
    initLogging()
    consoleTransport.writeFn({})

    expect(consoleTransport.level).toBe(false)
  })

  // This runs on every launch and deletes files. Nothing asserted which side of
  // the cutoff it deletes, so inverting the comparison — dropping every log
  // written in the last week and keeping the rest forever — stayed green.
  test("deletes only log files older than the retention window", () => {
    setupLog(() => {})
    const day = 24 * 60 * 60 * 1000
    const age = (file: string, days: number) => {
      const seconds = (Date.now() - days * day) / 1000
      utimesSync(join(logDir, file), seconds, seconds)
    }
    for (const name of ["desktop.log", "desktop.old.log", "renderer.log"]) {
      writeFileSync(join(logDir, name), "entry\n", "utf8")
    }
    mkdirSync(join(logDir, "crashes"))
    age("desktop.log", 0)
    age("desktop.old.log", 8)
    age("renderer.log", 6)

    initLogging()

    expect(existsSync(join(logDir, "desktop.log"))).toBe(true)
    expect(existsSync(join(logDir, "renderer.log"))).toBe(true)
    expect(existsSync(join(logDir, "desktop.old.log"))).toBe(false)
    expect(existsSync(join(logDir, "crashes"))).toBe(true)
  })

  test("rethrows non-broken-pipe console transport errors", async () => {
    const err = otherWriteError()
    const consoleTransport = setupLog(() => {
      throw err
    })
    initLogging()

    expect(() => consoleTransport.writeFn({})).toThrow(err)
    expect(consoleTransport.level).toBe("info")
  })

})
