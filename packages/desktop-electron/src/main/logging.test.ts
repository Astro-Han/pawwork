import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

let logDir = ""
const fakeLog: {
  transports: {
    file: {
      maxSize: number
      getFile: () => { path: string }
    }
    console: {
      level: string | false
      wrapCount: number
      writeFn: (options: unknown) => void
    }
  }
} = {
  transports: {
    file: {
      maxSize: 0,
      getFile: () => ({ path: join(tmpdir(), "desktop.log") }),
    },
    console: {
      level: "info",
      wrapCount: 0,
      writeFn: () => undefined,
    },
  },
}

mock.module("electron-log/main.js", () => ({
  default: fakeLog,
}))

afterEach(() => {
  if (logDir) rmSync(logDir, { recursive: true, force: true })
  logDir = ""
})

afterAll(() => {
  mock.restore()
})

function setupLog(writeFn: (options: unknown) => void) {
  logDir = mkdtempSync(join(tmpdir(), "pawwork-logging-test-"))
  let currentWriteFn = writeFn
  let wrapCount = 0
  fakeLog.transports.file = {
    maxSize: 0,
    getFile: () => ({ path: join(logDir, "desktop.log") }),
  }
  fakeLog.transports.console = {
    level: "info",
    get wrapCount() {
      return wrapCount
    },
    get writeFn() {
      return currentWriteFn
    },
    set writeFn(next) {
      wrapCount++
      currentWriteFn = next
    },
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
    const { initLogging } = await import(`./logging?logging-test=${crypto.randomUUID()}`)

    initLogging()
    consoleTransport.writeFn({})

    expect(consoleTransport.level).toBe(false)
  })

  test("rethrows non-broken-pipe console transport errors", async () => {
    const err = otherWriteError()
    const consoleTransport = setupLog(() => {
      throw err
    })
    const { initLogging } = await import(`./logging?logging-test=${crypto.randomUUID()}`)

    initLogging()

    expect(() => consoleTransport.writeFn({})).toThrow(err)
    expect(consoleTransport.level).toBe("info")
  })

  test("does not wrap the console transport more than once", async () => {
    const consoleTransport = setupLog(() => undefined)
    const { initLogging } = await import(`./logging?logging-test=${crypto.randomUUID()}`)

    initLogging()
    initLogging()

    expect(consoleTransport.wrapCount).toBe(1)
  })
})
