import { describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Pty } from "../../src/pty"
import type { PtyID } from "../../src/pty/schema"
import { tmpdir } from "../fixture/fixture"
import { setTimeout as sleep } from "node:timers/promises"

const wait = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(25)
  }
  throw new Error("timeout waiting for pty events")
}

const pick = (log: Array<{ type: "created" | "exited" | "deleted"; id: PtyID }>, id: PtyID) => {
  return log.filter((evt) => evt.id === id).map((evt) => evt.type)
}

describe("pty", () => {
  test("publishes created, exited, deleted in order for a short-lived process", async () => {
    if (process.platform === "win32") return

    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const log: Array<{ type: "created" | "exited" | "deleted"; id: PtyID }> = []
        const off = [
          Bus.subscribe(Pty.Event.Created, (evt) => log.push({ type: "created", id: evt.properties.info.id })),
          Bus.subscribe(Pty.Event.Exited, (evt) => log.push({ type: "exited", id: evt.properties.id })),
          Bus.subscribe(Pty.Event.Deleted, (evt) => log.push({ type: "deleted", id: evt.properties.id })),
        ]

        let id: PtyID | undefined
        try {
          const info = await Pty.create({
            command: "/usr/bin/env",
            args: ["sh", "-c", "sleep 0.1"],
            title: "sleep",
          })
          id = info.id

          await wait(() => pick(log, id!).includes("exited"))

          await Pty.remove(id)
          await wait(() => pick(log, id!).length >= 3)
          expect(pick(log, id!)).toEqual(["created", "exited", "deleted"])
        } finally {
          off.forEach((x) => x())
          if (id) await Pty.remove(id)
        }
      },
    })
  })

  test("publishes created, exited, deleted in order for /bin/sh + remove", async () => {
    if (process.platform === "win32") return

    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const log: Array<{ type: "created" | "exited" | "deleted"; id: PtyID }> = []
        const off = [
          Bus.subscribe(Pty.Event.Created, (evt) => log.push({ type: "created", id: evt.properties.info.id })),
          Bus.subscribe(Pty.Event.Exited, (evt) => log.push({ type: "exited", id: evt.properties.id })),
          Bus.subscribe(Pty.Event.Deleted, (evt) => log.push({ type: "deleted", id: evt.properties.id })),
        ]

        let id: PtyID | undefined
        try {
          const info = await Pty.create({ command: "/bin/sh", title: "sh" })
          id = info.id

          await sleep(100)

          await Pty.remove(id)
          await wait(() => pick(log, id!).length >= 3)
          expect(pick(log, id!)).toEqual(["created", "exited", "deleted"])
        } finally {
          off.forEach((x) => x())
          if (id) await Pty.remove(id)
        }
      },
    })
  })

  test("does not expose internal server auth env to terminal sessions", async () => {
    if (process.platform === "win32") return

    const previousUsername = process.env.OPENCODE_SERVER_USERNAME
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    const previousCustom = process.env.PAWWORK_E2E_CUSTOM_ENV
    process.env.OPENCODE_SERVER_USERNAME = "PawWork"
    process.env.OPENCODE_SERVER_PASSWORD = "secret"
    process.env.PAWWORK_E2E_CUSTOM_ENV = "kept"

    try {
      await using dir = await tmpdir({ git: true })

      await Instance.provide({
        directory: dir.path,
        fn: async () => {
          let id: PtyID | undefined
          try {
            const info = await Pty.create({
              command: "/bin/sh",
              title: "env",
            })
            id = info.id

            const output: string[] = []
            await Pty.connect(info.id, {
              readyState: 1,
              send: (data: unknown) => output.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8")),
              close: () => undefined,
            } as any)

            await Pty.write(
              info.id,
              'printf "username=%s\\n" "${OPENCODE_SERVER_USERNAME}" && printf "password=%s\\n" "${OPENCODE_SERVER_PASSWORD}" && printf "custom=%s\\n" "${PAWWORK_E2E_CUSTOM_ENV-unset}"\nexit\n',
            )
            await wait(() => output.join("").includes("custom="))

            const text = output.join("")
            expect(text).toContain("username=")
            expect(text).toContain("password=")
            expect(text).toContain("custom=kept")
            expect(text).not.toContain("secret")
            expect(text).not.toContain("PawWork")
          } finally {
            if (id) await Pty.remove(id)
          }
        },
      })
    } finally {
      if (previousUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
      else process.env.OPENCODE_SERVER_USERNAME = previousUsername
      if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = previousPassword
      if (previousCustom === undefined) delete process.env.PAWWORK_E2E_CUSTOM_ENV
      else process.env.PAWWORK_E2E_CUSTOM_ENV = previousCustom
    }
  })

  test("preserves explicit terminal auth env overrides", async () => {
    if (process.platform === "win32") return

    const previousUsername = process.env.OPENCODE_SERVER_USERNAME
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    process.env.OPENCODE_SERVER_USERNAME = "PawWork"
    process.env.OPENCODE_SERVER_PASSWORD = "secret"

    try {
      await using dir = await tmpdir({ git: true })

      await Instance.provide({
        directory: dir.path,
        fn: async () => {
          let id: PtyID | undefined
          try {
            const info = await Pty.create({
              command: "/bin/sh",
              title: "explicit-env",
              env: {
                OPENCODE_SERVER_USERNAME: "explicit-user",
                OPENCODE_SERVER_PASSWORD: "explicit-password",
              },
            })
            id = info.id

            const output: string[] = []
            await Pty.connect(info.id, {
              readyState: 1,
              send: (data: unknown) => output.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8")),
              close: () => undefined,
            } as any)

            await Pty.write(
              info.id,
              'printf "username=%s\\n" "${OPENCODE_SERVER_USERNAME}" && printf "password=%s\\n" "${OPENCODE_SERVER_PASSWORD}"\nexit\n',
            )
            await wait(() => output.join("").includes("password="))

            const text = output.join("")
            expect(text).toContain("username=explicit-user")
            expect(text).toContain("password=explicit-password")
            expect(text).not.toContain("secret")
            expect(text).not.toContain("PawWork")
          } finally {
            if (id) await Pty.remove(id)
          }
        },
      })
    } finally {
      if (previousUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
      else process.env.OPENCODE_SERVER_USERNAME = previousUsername
      if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = previousPassword
    }
  })
})
