import { describe, expect, test } from "bun:test"

const browserCheck = String.raw`
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { createTimelineStaging } from "./src/pages/session/session-timeline-staging.ts"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const message = (id) => ({
  id: "msg_" + id,
  role: "user",
  time: { created: id },
})
const messages = (count) => Array.from({ length: count }, (_, index) => message(index))
const ids = (list) => list.map((item) => item.id).join(",")

const installAnimationFrameQueue = () => {
  let nextID = 1
  const frames = new Map()
  const canceled = []

  globalThis.requestAnimationFrame = (callback) => {
    const id = nextID++
    frames.set(id, callback)
    return id
  }

  globalThis.cancelAnimationFrame = (id) => {
    canceled.push(id)
    frames.delete(id)
  }

  return {
    canceled,
    pending: () => frames.size,
    pendingIDs: () => [...frames.keys()],
    flushOne: () => {
      const next = frames.entries().next()
      if (next.done) return false
      const [id, callback] = next.value
      frames.delete(id)
      callback(performance.now())
      return true
    },
  }
}

const mount = (factory) => {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(factory, root)
  return () => {
    dispose()
    root.remove()
  }
}

{
  const raf = installAnimationFrameQueue()
  let staging
  const dispose = mount(() => {
    staging = createTimelineStaging({
      sessionKey: () => "ses_1",
      turnStart: () => 0,
      messages: () => messages(14),
      config: { init: 10, batch: 3 },
    })
    return null
  })

  assert(ids(staging.messages()) === ids(messages(14)), "non-windowed timeline should render all messages")
  assert(staging.isStaging() === false, "non-windowed timeline should not stage")
  assert(raf.pending() === 0, "non-windowed timeline should not schedule frames")
  dispose()
}

{
  const raf = installAnimationFrameQueue()
  let staging
  const dispose = mount(() => {
    staging = createTimelineStaging({
      sessionKey: () => "ses_1",
      turnStart: () => 6,
      messages: () => messages(16),
      config: { init: 10, batch: 3 },
    })
    return null
  })

  assert(ids(staging.messages()) === ids(messages(16).slice(6)), "history window should start at init size")
  assert(staging.isStaging() === true, "history window should report active staging")
  assert(raf.pending() === 1, "history window should schedule one frame")
  assert(raf.flushOne() === true, "first staging frame should run")
  assert(ids(staging.messages()) === ids(messages(16).slice(3)), "first frame should add one batch")
  assert(staging.isStaging() === true, "staging should remain active before completion")
  assert(raf.flushOne() === true, "second staging frame should run")
  assert(ids(staging.messages()) === ids(messages(16)), "second frame should complete staging")
  assert(staging.isStaging() === false, "completed staging should clear active state")
  assert(raf.pending() === 0, "completed staging should not leave pending frames")
  dispose()
}

{
  const raf = installAnimationFrameQueue()
  let staging
  let setCount
  const dispose = mount(() => {
    const [count, nextCount] = createSignal(16)
    setCount = nextCount
    staging = createTimelineStaging({
      sessionKey: () => "ses_1",
      turnStart: () => 6,
      messages: () => messages(count()),
      config: { init: 10, batch: 3 },
    })
    return null
  })

  const firstFrame = raf.pendingIDs()[0]
  assert(firstFrame !== undefined, "active staging should schedule a frame")
  setCount(18)
  assert(ids(staging.messages()) === ids(messages(18).slice(8)), "active staging should not pop to all messages")
  assert(staging.isStaging() === true, "message growth should keep staging active")
  assert(raf.pendingIDs().includes(firstFrame), "message growth should keep the existing staging frame")
  assert(raf.flushOne() === true, "existing staging frame should continue after growth")
  assert(ids(staging.messages()) === ids(messages(18).slice(5)), "continued staging should add one batch after growth")
  dispose()
}

{
  const raf = installAnimationFrameQueue()
  let staging
  let setCount
  const dispose = mount(() => {
    const [count, nextCount] = createSignal(13)
    setCount = nextCount
    staging = createTimelineStaging({
      sessionKey: () => "ses_1",
      turnStart: () => 3,
      messages: () => messages(count()),
      config: { init: 10, batch: 3 },
    })
    return null
  })

  assert(ids(staging.messages()) === ids(messages(13).slice(3)), "completed-session case should start windowed")
  assert(raf.flushOne() === true, "completion frame should run")
  assert(ids(staging.messages()) === ids(messages(13)), "completion frame should reveal all")
  assert(staging.isStaging() === false, "completion should clear active state")
  setCount(16)
  assert(ids(staging.messages()) === ids(messages(16)), "completed session backfill should render immediately")
  assert(staging.isStaging() === false, "completed session backfill should not restage")
  assert(raf.pending() === 0, "completed session backfill should not schedule frames")
  dispose()
}

{
  const raf = installAnimationFrameQueue()
  let staging
  let setSessionKey
  const dispose = mount(() => {
    const [sessionKey, nextSessionKey] = createSignal("ses_1")
    setSessionKey = nextSessionKey
    staging = createTimelineStaging({
      sessionKey,
      turnStart: () => 6,
      messages: () => messages(16),
      config: { init: 10, batch: 3 },
    })
    return null
  })

  const firstFrame = raf.pendingIDs()[0]
  assert(firstFrame !== undefined, "initial history staging should schedule a frame")
  setSessionKey("ses_2")
  assert(raf.canceled.includes(firstFrame), "session switch should cancel the previous frame")
  assert(raf.pending() === 1, "session switch should leave one new frame for the new session")
  assert(ids(staging.messages()) === ids(messages(16).slice(6)), "new session should restart at init size")
  assert(raf.flushOne() === true, "new session frame should run")
  assert(ids(staging.messages()) === ids(messages(16).slice(3)), "new session frame should add one batch")
  dispose()
}
`

describe("createTimelineStaging", () => {
  test("preserves browser staging behavior", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--conditions=browser", "--preload", "./happydom.ts", "-e", browserCheck],
      cwd: new URL("../../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    })

    const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`
    expect(output).toBe("")
    expect(result.exitCode).toBe(0)
  })
})
