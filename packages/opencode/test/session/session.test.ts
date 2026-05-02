import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { Session as SessionNs } from "../../src/session"
import { Bus } from "../../src/bus"
import { Log } from "@opencode-ai/core/util/log"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import { Database, eq } from "../../src/storage/db"
import { MessageTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { canonicalDirectory } from "../../src/session/execution-context"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

describe("PawWork runtime namespace", () => {
  test("session error event schema can be imported without eager assistant shape access", () => {
    expect(SessionNs.Event.Error.properties.shape.error).toBeDefined()
    const result = SessionNs.Event.Error.properties.safeParse({
      error: new MessageV2.ContextOverflowError({ message: "context exceeded" }).toObject(),
    })
    expect(result.success).toBe(true)
  })

  test("plan files use .pawwork in git projects", async () => {
    await using tmp = await tmpdir({ git: true })
    const previous = process.env.PAWWORK_RUNTIME_NAMESPACE
    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(SessionNs.plan({ slug: "test-plan", time: { created: 123 } })).toBe(
            path.join(tmp.path, ".pawwork", "plans", "123-test-plan.md"),
          )
        },
      })
    } finally {
      if (previous === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previous
    }
  })
})

describe("session.created event", () => {
  test("executionContext for a new git session is rooted at project worktree, not entry directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "packages", "app")
    await fs.mkdir(subdir, { recursive: true })
    await Bun.write(path.join(subdir, ".keep"), "")

    await Instance.provide({
      directory: subdir,
      fn: async () => {
        const info = await SessionNs.create({})

        expect(info.directory).toBe(subdir)
        expect(info.executionContext.ownerDirectory).toBe(tmp.path)
        expect(info.executionContext.activeDirectory).toBe(tmp.path)
        expect(info.executionContext.activeWorktree).toBeUndefined()

        await SessionNs.remove(info.id)
      },
    })
  })

  test("findActiveWorktreeBinding checks activeWorktree directory without list caps", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = path.join(tmp.path, ".worktrees", "pawwork", "feature-a")
    await fs.mkdir(worktree, { recursive: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "bound worktree" })
        await SessionNs.findActiveWorktreeBinding(worktree).then((found) => expect(found).toBeUndefined())

        await SessionNs.updateExecutionContext({
          sessionID: session.id,
          activeDirectory: worktree,
          activeWorktree: {
            directory: worktree,
            name: "feature-a",
            branch: "pawwork/feature-a",
            source: "created",
          },
        })

        const found = await SessionNs.findActiveWorktreeBinding(worktree)
        expect(found?.id).toBe(session.id)

        const variant = path.join(worktree, "..", "feature-a")
        const foundByVariant = await SessionNs.findActiveWorktreeBinding(variant)
        expect(foundByVariant?.id).toBe(session.id)

        await SessionNs.remove(session.id)
      },
    })
  })

  test("findActiveWorktreeBinding does not treat path variants of the owner as worktree bindings", async () => {
    await using tmp = await tmpdir({ git: true })
    const ownerVariant = `${tmp.path}${path.sep}`

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "root path variant" })
        await SessionNs.updateExecutionContext({
          sessionID: session.id,
          activeDirectory: ownerVariant,
          activeWorktree: null,
        })

        const found = await SessionNs.findActiveWorktreeBinding(ownerVariant)
        expect(found).toBeUndefined()

        await SessionNs.remove(session.id)
      },
    })
  })

  test("findActiveWorktreeBinding uses project fallback for invalid executionContext rows", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = path.join(tmp.path, ".worktrees", "pawwork", "invalid-binding")
    await fs.mkdir(worktree, { recursive: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "invalid binding" })
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ execution_context: { activeDirectory: worktree } as any })
            .where(eq(SessionTable.id, session.id))
            .run(),
        )

        const found = await SessionNs.findActiveWorktreeBinding(worktree)
        expect(found).toBeUndefined()

        await SessionNs.remove(session.id)
      },
    })
  })

  test("updateExecutionContext returns the persisted updated time", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = path.join(tmp.path, ".worktrees", "pawwork", "feature-b")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "update-context-time" })
        const updated = await SessionNs.updateExecutionContext({
          sessionID: session.id,
          activeDirectory: worktree,
          activeWorktree: {
            directory: worktree,
            name: "feature-b",
            branch: "pawwork/feature-b",
            source: "created",
          },
        })

        expect(updated.time.updated).toBe(updated.executionContext.lastChangedAt)
        expect(updated.time.updated).toBeGreaterThanOrEqual(session.time.updated)

        await SessionNs.remove(session.id)
      },
    })
  })

  test("updateExecutionContext keeps active directory and worktree metadata synchronized", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = path.join(tmp.path, ".worktrees", "pawwork", "feature-c")
    const worktreeInput = `${worktree}${path.sep}`
    const activeWorktree = {
      directory: worktreeInput,
      name: "feature-c",
      branch: "pawwork/feature-c",
      source: "created" as const,
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "update-context-sync" })

        const entered = await SessionNs.updateExecutionContext({
          sessionID: session.id,
          activeWorktree,
        })
        expect(entered.executionContext.activeDirectory).toBe(canonicalDirectory(worktree))
        expect(entered.executionContext.activeWorktree).toEqual({
          ...activeWorktree,
          directory: canonicalDirectory(worktree),
        })

        const nested = path.join(worktree, "nested")
        const nestedInput = `${nested}${path.sep}`
        const movedByDirectory = await SessionNs.updateExecutionContext({
          sessionID: session.id,
          activeDirectory: nestedInput,
          activeWorktree: undefined,
        })
        expect(movedByDirectory.executionContext.activeDirectory).toBe(canonicalDirectory(nested))
        expect(movedByDirectory.executionContext.activeWorktree).toEqual({
          ...activeWorktree,
          directory: canonicalDirectory(worktree),
        })

        const clearedByWorktree = await SessionNs.updateExecutionContext({
          sessionID: session.id,
          activeWorktree: null,
        })
        expect(clearedByWorktree.executionContext.activeDirectory).toBe(tmp.path)
        expect(clearedByWorktree.executionContext.activeWorktree).toBeUndefined()

        await SessionNs.updateExecutionContext({
          sessionID: session.id,
          activeWorktree,
        })
        const clearedByDirectory = await SessionNs.updateExecutionContext({
          sessionID: session.id,
          activeDirectory: `${tmp.path}${path.sep}`,
        })
        expect(canonicalDirectory(clearedByDirectory.executionContext.activeDirectory)).toBe(
          canonicalDirectory(tmp.path),
        )
        expect(clearedByDirectory.executionContext.activeWorktree).toBeUndefined()

        await SessionNs.remove(session.id)
      },
    })
  })

  test("backfills legacy null executionContext rows", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "legacy-execution-context" })
        Database.use((db) =>
          db.update(SessionTable).set({ execution_context: null }).where(eq(SessionTable.id, session.id)).run(),
        )

        const count = await Effect.runPromise(SessionNs.backfillExecutionContext)
        expect(count).toBeGreaterThanOrEqual(1)

        const expectedRoot = canonicalDirectory(tmp.path)
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get())
        expect(row?.execution_context?.ownerDirectory).toBe(expectedRoot)
        expect(row?.execution_context?.activeDirectory).toBe(expectedRoot)

        await SessionNs.remove(session.id)
      },
    })
  })

  test("backfills legacy executionContext rows with canonical project roots", async () => {
    await using tmp = await tmpdir({ git: true })
    const projectLink = path.join(tmp.path, "project-link")
    await fs.symlink(tmp.path, projectLink)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "legacy-canonical-root" })
        Database.use((db) => {
          db.update(ProjectTable).set({ worktree: projectLink }).where(eq(ProjectTable.id, session.projectID)).run()
          db.update(SessionTable).set({ execution_context: null }).where(eq(SessionTable.id, session.id)).run()
        })

        const count = await Effect.runPromise(SessionNs.backfillExecutionContext)
        expect(count).toBeGreaterThanOrEqual(1)

        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get())
        expect(row?.execution_context?.ownerDirectory).toBe(canonicalDirectory(projectLink))
        expect(row?.execution_context?.activeDirectory).toBe(canonicalDirectory(projectLink))

        await SessionNs.remove(session.id)
      },
    })
  })

  test("synthesizes legacy null executionContext from the project root on read", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "packages", "app")
    await fs.mkdir(subdir, { recursive: true })

    await Instance.provide({
      directory: subdir,
      fn: async () => {
        const session = await SessionNs.create({ title: "legacy-read-root" })
        Database.use((db) =>
          db.update(SessionTable).set({ execution_context: null }).where(eq(SessionTable.id, session.id)).run(),
        )

        const loaded = await SessionNs.get(session.id)
        const expectedRoot = canonicalDirectory(tmp.path)
        expect(loaded.directory).toBe(subdir)
        expect(loaded.executionContext.ownerDirectory).toBe(expectedRoot)
        expect(loaded.executionContext.activeDirectory).toBe(expectedRoot)

        const listed = Array.from(SessionNs.list()).find((item) => item.id === session.id)
        expect(listed?.executionContext.ownerDirectory).toBe(expectedRoot)
        expect(listed?.executionContext.activeDirectory).toBe(expectedRoot)

        const globalListed = Array.from(SessionNs.listGlobal()).find((item) => item.id === session.id)
        expect(globalListed?.executionContext.ownerDirectory).toBe(expectedRoot)
        expect(globalListed?.executionContext.activeDirectory).toBe(expectedRoot)

        await SessionNs.remove(session.id)
      },
    })
  })

  test("synthesizes invalid executionContext from the project root on read", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "packages", "app")
    await fs.mkdir(subdir, { recursive: true })

    await Instance.provide({
      directory: subdir,
      fn: async () => {
        const session = await SessionNs.create({ title: "invalid-read-root" })
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ execution_context: { activeDirectory: subdir } as any })
            .where(eq(SessionTable.id, session.id))
            .run(),
        )

        const loaded = await SessionNs.get(session.id)
        const expectedRoot = canonicalDirectory(tmp.path)
        expect(loaded.directory).toBe(subdir)
        expect(loaded.executionContext.ownerDirectory).toBe(expectedRoot)
        expect(loaded.executionContext.activeDirectory).toBe(expectedRoot)

        const listed = Array.from(SessionNs.list()).find((item) => item.id === session.id)
        expect(listed?.executionContext.ownerDirectory).toBe(expectedRoot)
        expect(listed?.executionContext.activeDirectory).toBe(expectedRoot)

        const globalListed = Array.from(SessionNs.listGlobal()).find((item) => item.id === session.id)
        expect(globalListed?.executionContext.ownerDirectory).toBe(expectedRoot)
        expect(globalListed?.executionContext.activeDirectory).toBe(expectedRoot)

        await SessionNs.remove(session.id)
      },
    })
  })

  test("recovers partial activeWorktree by preserving active directory only", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "packages", "app")
    const worktree = path.join(tmp.path, ".worktrees", "pawwork", "partial-worktree")
    await fs.mkdir(subdir, { recursive: true })

    await Instance.provide({
      directory: subdir,
      fn: async () => {
        const session = await SessionNs.create({ title: "partial-active-worktree" })
        const expectedRoot = canonicalDirectory(tmp.path)
        const expectedActive = canonicalDirectory(worktree)
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({
              execution_context: {
                ownerDirectory: tmp.path,
                activeDirectory: worktree,
                activeWorktree: {
                  directory: worktree,
                  name: "partial-worktree",
                  branch: "pawwork/partial-worktree",
                },
                lastChangedAt: 123,
              } as any,
            })
            .where(eq(SessionTable.id, session.id))
            .run(),
        )

        const loaded = await SessionNs.get(session.id)
        expect(loaded.executionContext.ownerDirectory).toBe(expectedRoot)
        expect(loaded.executionContext.activeDirectory).toBe(expectedActive)
        expect(loaded.executionContext.activeWorktree).toBeUndefined()

        const listed = Array.from(SessionNs.list()).find((item) => item.id === session.id)
        expect(listed?.executionContext.ownerDirectory).toBe(expectedRoot)
        expect(listed?.executionContext.activeDirectory).toBe(expectedActive)
        expect(listed?.executionContext.activeWorktree).toBeUndefined()

        const globalListed = Array.from(SessionNs.listGlobal()).find((item) => item.id === session.id)
        expect(globalListed?.executionContext.ownerDirectory).toBe(expectedRoot)
        expect(globalListed?.executionContext.activeDirectory).toBe(expectedActive)
        expect(globalListed?.executionContext.activeWorktree).toBeUndefined()

        await SessionNs.remove(session.id)
      },
    })
  })

  test("synthesizes relative executionContext from the project root on read", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "packages", "app")
    await fs.mkdir(subdir, { recursive: true })

    await Instance.provide({
      directory: subdir,
      fn: async () => {
        const session = await SessionNs.create({ title: "relative-read-root" })
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({
              execution_context: {
                ownerDirectory: ".",
                activeDirectory: "relative-worktree",
                activeWorktree: {
                  directory: "relative-worktree",
                  name: "relative-worktree",
                  branch: "pawwork/relative-worktree",
                  source: "created",
                },
                lastChangedAt: 123,
              } as any,
            })
            .where(eq(SessionTable.id, session.id))
            .run(),
        )

        const expectedRoot = canonicalDirectory(tmp.path)
        const loaded = await SessionNs.get(session.id)
        expect(loaded.executionContext.ownerDirectory).toBe(expectedRoot)
        expect(loaded.executionContext.activeDirectory).toBe(expectedRoot)
        expect(loaded.executionContext.activeWorktree).toBeUndefined()

        const listed = Array.from(SessionNs.list()).find((item) => item.id === session.id)
        expect(listed?.executionContext.ownerDirectory).toBe(expectedRoot)
        expect(listed?.executionContext.activeDirectory).toBe(expectedRoot)
        expect(listed?.executionContext.activeWorktree).toBeUndefined()

        const globalListed = Array.from(SessionNs.listGlobal()).find((item) => item.id === session.id)
        expect(globalListed?.executionContext.ownerDirectory).toBe(expectedRoot)
        expect(globalListed?.executionContext.activeDirectory).toBe(expectedRoot)
        expect(globalListed?.executionContext.activeWorktree).toBeUndefined()

        await SessionNs.remove(session.id)
      },
    })
  })

  test("drops stale activeWorktree metadata when active directory is the project root", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = path.join(tmp.path, ".worktrees", "pawwork", "stale-worktree")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "stale-active-worktree" })
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({
              execution_context: {
                ownerDirectory: tmp.path,
                activeDirectory: `${tmp.path}${path.sep}`,
                activeWorktree: {
                  directory: worktree,
                  name: "stale-worktree",
                  branch: "pawwork/stale-worktree",
                  source: "created",
                },
                lastChangedAt: "invalid",
              } as any,
            })
            .where(eq(SessionTable.id, session.id))
            .run(),
        )

        const loaded = await SessionNs.get(session.id)
        expect(loaded.executionContext.ownerDirectory).toBe(canonicalDirectory(tmp.path))
        expect(loaded.executionContext.activeDirectory).toBe(canonicalDirectory(tmp.path))
        expect(loaded.executionContext.activeWorktree).toBeUndefined()

        await SessionNs.remove(session.id)
      },
    })
  })

  test("fork preserves the source session executionContext", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = path.join(tmp.path, ".worktrees", "pawwork", "forked-work")
    const activeWorktree = {
      directory: worktree,
      name: "forked-work",
      branch: "pawwork/forked-work",
      source: "created" as const,
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "fork-source-worktree" })
        await SessionNs.updateExecutionContext({
          sessionID: session.id,
          activeWorktree,
        })

        const forked = await SessionNs.fork({ sessionID: session.id })
        expect(forked.executionContext.ownerDirectory).toBe(tmp.path)
        expect(forked.executionContext.activeDirectory).toBe(worktree)
        expect(forked.executionContext.activeWorktree).toEqual(activeWorktree)

        await SessionNs.remove(forked.id)
        await SessionNs.remove(session.id)
      },
    })
  })

  test("should emit session.created event when session is created", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventReceived = false
        let receivedInfo: SessionNs.Info | undefined

        const unsub = Bus.subscribe(SessionNs.Event.Created, (event) => {
          eventReceived = true
          receivedInfo = event.properties.info as SessionNs.Info
        })

        const info = await SessionNs.create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsub()

        expect(eventReceived).toBe(true)
        expect(receivedInfo).toBeDefined()
        expect(receivedInfo?.id).toBe(info.id)
        expect(receivedInfo?.projectID).toBe(info.projectID)
        expect(receivedInfo?.directory).toBe(info.directory)
        expect(receivedInfo?.title).toBe(info.title)

        await SessionNs.remove(info.id)
      },
    })
  })

  test("session.created event should be emitted before session.updated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const events: string[] = []

        const unsubCreated = Bus.subscribe(SessionNs.Event.Created, () => {
          events.push("created")
        })

        const unsubUpdated = Bus.subscribe(SessionNs.Event.Updated, () => {
          events.push("updated")
        })

        const info = await SessionNs.create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsubCreated()
        unsubUpdated()

        expect(events).toContain("created")
        expect(events).toContain("updated")
        expect(events.indexOf("created")).toBeLessThan(events.indexOf("updated"))

        await SessionNs.remove(info.id)
      },
    })
  })
})

describe("MessageV2 hydration", () => {
  test("normalizes legacy assistant string path from database rows", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "legacy-message-path" })
        const messageID = MessageID.ascending()
        const parentID = MessageID.ascending()
        const created = Date.now()

        Database.use((db) =>
          db
            .insert(MessageTable)
            .values({
              id: messageID,
              session_id: session.id,
              time_created: created,
              data: {
                role: "assistant",
                time: { created, completed: created },
                parentID,
                modelID: "test-model",
                providerID: "test-provider",
                mode: "",
                agent: "general",
                path: tmp.path,
                cost: 0,
                tokens: {
                  total: 0,
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
              } as any,
            })
            .run(),
        )

        const got = MessageV2.get({ sessionID: session.id, messageID })
        expect((got.info as MessageV2.Assistant).path).toEqual({ cwd: tmp.path, root: tmp.path })

        await SessionNs.remove(session.id)
      },
    })
  })
})

describe("step-finish token propagation via Bus event", () => {
  test(
    "non-zero tokens propagate through PartUpdated event",
    async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const info = await SessionNs.create({})

          const messageID = MessageID.ascending()
          await SessionNs.updateMessage({
            id: messageID,
            sessionID: info.id,
            role: "user",
            time: { created: Date.now() },
            agent: "user",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)

          // Bus subscribers receive readonly Schema.Type payloads; `MessageV2.Part`
          // is the mutable domain type. Cast bridges the two — safe because the
          // test only reads the value afterwards.
          let received: MessageV2.Part | undefined
          const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            received = event.properties.part as MessageV2.Part
          })

          const tokens = {
            total: 1500,
            input: 500,
            output: 800,
            reasoning: 200,
            cache: { read: 100, write: 50 },
          }

          const partInput = {
            id: PartID.ascending(),
            messageID,
            sessionID: info.id,
            type: "step-finish" as const,
            reason: "stop",
            cost: 0.005,
            tokens,
          }

          await SessionNs.updatePart(partInput)
          await new Promise((resolve) => setTimeout(resolve, 100))

          expect(received).toBeDefined()
          expect(received!.type).toBe("step-finish")
          const finish = received as MessageV2.StepFinishPart
          expect(finish.tokens.input).toBe(500)
          expect(finish.tokens.output).toBe(800)
          expect(finish.tokens.reasoning).toBe(200)
          expect(finish.tokens.total).toBe(1500)
          expect(finish.tokens.cache.read).toBe(100)
          expect(finish.tokens.cache.write).toBe(50)
          expect(finish.cost).toBe(0.005)
          expect(received).not.toBe(partInput)

          unsub()
          await SessionNs.remove(info.id)
        },
      })
    },
    { timeout: 30000 },
  )
})

describe("Session", () => {
  test("remove works without an instance", async () => {
    await using tmp = await tmpdir({ git: true })

    const info = await Instance.provide({
      directory: tmp.path,
      fn: () => SessionNs.create({ title: "remove-without-instance" }),
    })

    await expect(async () => {
      await SessionNs.remove(info.id)
    }).not.toThrow()

    let missing = false
    await SessionNs.get(info.id).catch(() => {
      missing = true
    })

    expect(missing).toBe(true)
  })
})
