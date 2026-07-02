import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

  test("does not wrap the console transport again across fresh module imports", async () => {
    const consoleTransport = setupLog(() => undefined)
    const first = await import(`./logging?logging-test=${crypto.randomUUID()}`)
    const second = await import(`./logging?logging-test=${crypto.randomUUID()}`)

    first.initLogging()
    second.initLogging()

    expect(consoleTransport.wrapCount).toBe(1)
  })

  test("builds a diagnostics log tail from main and backend logs", async () => {
    logDir = mkdtempSync(join(tmpdir(), "pawwork-logging-test-"))
    const mainPath = join(logDir, "main.log")
    const backendPath = join(logDir, "backend.log")
    writeFileSync(mainPath, "main ok\nmain failed\n")
    writeFileSync(backendPath, "backend ok\nbackend failed\n")
    fakeLog.transports.file = {
      maxSize: 0,
      getFile: () => ({ path: mainPath }),
    }

    const { diagnosticsLogTail } = await import(`./logging?logging-test=${crypto.randomUUID()}`)
    const tail = diagnosticsLogTail({ backendLogPath: backendPath })

    expect(tail).toContain("Main process log")
    expect(tail).toContain("main failed")
    expect(tail).toContain("Backend log")
    expect(tail).toContain("backend failed")
  })

  test("bounds the tail to the most recent bytes of a large file", async () => {
    logDir = mkdtempSync(join(tmpdir(), "pawwork-logging-test-"))
    const mainPath = join(logDir, "main.log")
    // Larger than the 512 KB byte cap so the oldest content falls outside the tail.
    const filler = Array.from({ length: 60_000 }, (_, i) => `entry ${i}`).join("\n")
    writeFileSync(mainPath, ["OLDEST_LINE", filler, "NEWEST_LINE"].join("\n"))
    fakeLog.transports.file = {
      maxSize: 0,
      getFile: () => ({ path: mainPath }),
    }

    const { diagnosticsLogTail } = await import(`./logging?logging-test=${crypto.randomUUID()}`)
    const tail = diagnosticsLogTail({})

    expect(tail).toContain("NEWEST_LINE")
    expect(tail).not.toContain("OLDEST_LINE")
    // The main-log section is bounded by the byte-tail read (plus the section header), not the file.
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(512 * 1024 + 4_096)
  })

  test("drops a mid-line fragment instead of emitting it before redaction", async () => {
    logDir = mkdtempSync(join(tmpdir(), "pawwork-logging-test-"))
    const mainPath = join(logDir, "main.log")
    // A single line larger than the 512 KB byte cap with no newline: the byte tail starts mid-line.
    // Emitting that fragment would feed redaction a prefix-less secret, so it must be dropped.
    writeFileSync(mainPath, "S".repeat(600_000))
    fakeLog.transports.file = {
      maxSize: 0,
      getFile: () => ({ path: mainPath }),
    }

    const { diagnosticsLogTail } = await import(`./logging?logging-test=${crypto.randomUUID()}`)
    const tail = diagnosticsLogTail({})

    expect(tail).toContain("(empty)")
    expect(tail).not.toContain("S".repeat(100))
  })
})
