import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instruction, projectFiles } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { Instance } from "../../src/project/instance"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

const run = <A>(effect: Effect.Effect<A, any, Instruction.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Instruction.defaultLayer)))

function loaded(filepath: string): MessageV2.WithParts[] {
  const sessionID = SessionID.make("session-loaded-1")
  const messageID = MessageID.make("message-loaded-1")

  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: ProviderID.make("anthropic"),
          modelID: ModelID.make("claude-sonnet-4-20250514"),
        },
      },
      parts: [
        {
          id: PartID.make("part-loaded-1"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-loaded-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: { loaded: [filepath] },
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

describe("Instruction.resolve", () => {
  test("returns empty when AGENTS.md is at project root (already in systemPaths)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Root Instructions")
        await Bun.write(path.join(dir, "src", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const system = yield* svc.systemPaths()
              expect(system.has(path.join(tmp.path, "AGENTS.md"))).toBe(true)

              const results = yield* svc.resolve(
                [],
                path.join(tmp.path, "src", "file.ts"),
                MessageID.make("message-test-1"),
              )
              expect(results).toEqual([])
            }),
          ),
        ),
    })
  })

  test("returns AGENTS.md from subdirectory (not in systemPaths)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const system = yield* svc.systemPaths()
              expect(system.has(path.join(tmp.path, "subdir", "AGENTS.md"))).toBe(false)

              const results = yield* svc.resolve(
                [],
                path.join(tmp.path, "subdir", "nested", "file.ts"),
                MessageID.make("message-test-2"),
              )
              expect(results.length).toBe(1)
              expect(results[0].filepath).toBe(path.join(tmp.path, "subdir", "AGENTS.md"))
            }),
          ),
        ),
    })
  })

  test("doesn't reload AGENTS.md when reading it directly", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const filepath = path.join(tmp.path, "subdir", "AGENTS.md")
              const system = yield* svc.systemPaths()
              expect(system.has(filepath)).toBe(false)

              const results = yield* svc.resolve([], filepath, MessageID.make("message-test-3"))
              expect(results).toEqual([])
            }),
          ),
        ),
    })
  })

  test("does not reattach the same nearby instructions twice for one message", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const filepath = path.join(tmp.path, "subdir", "nested", "file.ts")
              const id = MessageID.make("message-claim-1")

              const first = yield* svc.resolve([], filepath, id)
              const second = yield* svc.resolve([], filepath, id)

              expect(first).toHaveLength(1)
              expect(first[0].filepath).toBe(path.join(tmp.path, "subdir", "AGENTS.md"))
              expect(second).toEqual([])
            }),
          ),
        ),
    })
  })

  test("clear allows nearby instructions to be attached again for the same message", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const filepath = path.join(tmp.path, "subdir", "nested", "file.ts")
              const id = MessageID.make("message-claim-2")

              const first = yield* svc.resolve([], filepath, id)
              yield* svc.clear(id)
              const second = yield* svc.resolve([], filepath, id)

              expect(first).toHaveLength(1)
              expect(second).toHaveLength(1)
              expect(second[0].filepath).toBe(path.join(tmp.path, "subdir", "AGENTS.md"))
            }),
          ),
        ),
    })
  })

  test("skips instructions already reported by prior read metadata", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "AGENTS.md"), "# Subdir Instructions")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const agents = path.join(tmp.path, "subdir", "AGENTS.md")
              const filepath = path.join(tmp.path, "subdir", "nested", "file.ts")
              const id = MessageID.make("message-claim-3")

              const results = yield* svc.resolve(loaded(agents), filepath, id)
              expect(results).toEqual([])
            }),
          ),
        ),
    })
  })

  test.todo("fetches remote instructions from config URLs via HttpClient", () => {})
})

describe("projectFiles gate", () => {
  test("PawWork mode keeps CLAUDE.md even when OPENCODE_DISABLE_CLAUDE_CODE_PROMPT is set", () => {
    // Regression for issue #230 acceptance #6: a PawWork process inheriting the
    // disable flag must still discover project-level CLAUDE.md as compatibility.
    expect(projectFiles({ isPawWork: true, disableClaudeCodePrompt: true })).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "CONTEXT.md",
    ])
  })

  test("PawWork mode keeps CLAUDE.md when flag is unset", () => {
    expect(projectFiles({ isPawWork: true, disableClaudeCodePrompt: false })).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "CONTEXT.md",
    ])
  })

  test("opencode CLI mode drops CLAUDE.md when OPENCODE_DISABLE_CLAUDE_CODE_PROMPT is set", () => {
    expect(projectFiles({ isPawWork: false, disableClaudeCodePrompt: true })).toEqual([
      "AGENTS.md",
      "CONTEXT.md",
    ])
  })

  test("opencode CLI mode keeps CLAUDE.md when flag is unset", () => {
    expect(projectFiles({ isPawWork: false, disableClaudeCodePrompt: false })).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "CONTEXT.md",
    ])
  })
})

describe("Instruction.system", () => {
  test("loads both project and global AGENTS.md when both exist", async () => {
    const originalConfigDir = process.env["OPENCODE_CONFIG_DIR"]
    delete process.env["OPENCODE_CONFIG_DIR"]

    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Project Instructions")
      },
    })

    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const paths = yield* svc.systemPaths()
                expect(paths.has(path.join(projectTmp.path, "AGENTS.md"))).toBe(true)
                expect(paths.has(path.join(globalTmp.path, "AGENTS.md"))).toBe(true)

                const rules = yield* svc.system()
                expect(rules).toHaveLength(2)
                expect(rules).toContain(
                  `Instructions from: ${path.join(projectTmp.path, "AGENTS.md")}\n# Project Instructions`,
                )
                expect(rules).toContain(
                  `Instructions from: ${path.join(globalTmp.path, "AGENTS.md")}\n# Global Instructions`,
                )
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
      if (originalConfigDir === undefined) {
        delete process.env["OPENCODE_CONFIG_DIR"]
      } else {
        process.env["OPENCODE_CONFIG_DIR"] = originalConfigDir
      }
    }
  })
})

describe("Instruction.systemPaths OPENCODE_CONFIG_DIR", () => {
  let originalConfigDir: string | undefined

  beforeEach(() => {
    originalConfigDir = process.env["OPENCODE_CONFIG_DIR"]
  })

  afterEach(() => {
    if (originalConfigDir === undefined) {
      delete process.env["OPENCODE_CONFIG_DIR"]
    } else {
      process.env["OPENCODE_CONFIG_DIR"] = originalConfigDir
    }
  })

  test("prefers OPENCODE_CONFIG_DIR AGENTS.md over global when both exist", async () => {
    await using profileTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Profile Instructions")
      },
    })
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir()

    process.env["OPENCODE_CONFIG_DIR"] = profileTmp.path
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const paths = yield* svc.systemPaths()
                expect(paths.has(path.join(profileTmp.path, "AGENTS.md"))).toBe(true)
                expect(paths.has(path.join(globalTmp.path, "AGENTS.md"))).toBe(false)
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("falls back to global AGENTS.md when OPENCODE_CONFIG_DIR has no AGENTS.md", async () => {
    await using profileTmp = await tmpdir()
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir()

    process.env["OPENCODE_CONFIG_DIR"] = profileTmp.path
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const paths = yield* svc.systemPaths()
                expect(paths.has(path.join(profileTmp.path, "AGENTS.md"))).toBe(false)
                expect(paths.has(path.join(globalTmp.path, "AGENTS.md"))).toBe(true)
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("uses global AGENTS.md when OPENCODE_CONFIG_DIR is not set", async () => {
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir()

    delete process.env["OPENCODE_CONFIG_DIR"]
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const paths = yield* svc.systemPaths()
                expect(paths.has(path.join(globalTmp.path, "AGENTS.md"))).toBe(true)
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })
})

describe("Instruction.systemPaths PawWork runtime config dir", () => {
  const original = {
    opencodeConfigDir: process.env.OPENCODE_CONFIG_DIR,
    pawworkConfigDir: process.env.PAWWORK_CONFIG_DIR,
    runtimeNamespace: process.env.PAWWORK_RUNTIME_NAMESPACE,
    disableProjectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
    testHome: process.env.OPENCODE_TEST_HOME,
    disableClaudePrompt: process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT,
  }

  afterEach(() => {
    if (original.opencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = original.opencodeConfigDir
    if (original.pawworkConfigDir === undefined) delete process.env.PAWWORK_CONFIG_DIR
    else process.env.PAWWORK_CONFIG_DIR = original.pawworkConfigDir
    if (original.runtimeNamespace === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
    else process.env.PAWWORK_RUNTIME_NAMESPACE = original.runtimeNamespace
    if (original.disableProjectConfig === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = original.disableProjectConfig
    if (original.testHome === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = original.testHome
    if (original.disableClaudePrompt === undefined) delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    else process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = original.disableClaudePrompt
  })

  test("ignores OPENCODE_CONFIG_DIR AGENTS.md in PawWork runtime mode", async () => {
    await using profileTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# OpenCode Profile Instructions")
      },
    })
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_CONFIG_DIR = profileTmp.path
    delete process.env.PAWWORK_CONFIG_DIR
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const paths = yield* svc.systemPaths()
                expect(paths.has(path.join(profileTmp.path, "AGENTS.md"))).toBe(false)
                expect(paths.has(path.join(globalTmp.path, "AGENTS.md"))).toBe(true)
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("prefers PAWWORK_CONFIG_DIR AGENTS.md over global when both exist", async () => {
    await using profileTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# PawWork Profile Instructions")
      },
    })
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.PAWWORK_CONFIG_DIR = profileTmp.path
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const paths = yield* svc.systemPaths()
                expect(paths.has(path.join(profileTmp.path, "AGENTS.md"))).toBe(true)
                expect(paths.has(path.join(globalTmp.path, "AGENTS.md"))).toBe(false)
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("sources() reports ~/.claude/CLAUDE.md as ignored with reason when present in PawWork mode", async () => {
    // Acceptance criterion #7: diagnostics explain why the global Claude Code fallback
    // was ignored. Uses OPENCODE_TEST_HOME so Global.Path.home resolves to a tmpdir,
    // making the test deterministic across CI environments.
    await using fakeHome = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".claude", "CLAUDE.md"), "# Global Claude Instructions")
      },
    })
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    delete process.env.PAWWORK_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const sources = yield* svc.sources()
                const expected = path.resolve(path.join(fakeHome.path, ".claude", "CLAUDE.md"))
                const ignored = sources.find((s) => s.status === "ignored" && s.path === expected)
                expect(ignored).toBeDefined()
                if (ignored?.status === "ignored") {
                  expect(ignored.reason).toContain("PawWork")
                  expect(ignored.reason).toContain("Claude")
                }
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("sources() reports priority-skipped global instruction file as considered", async () => {
    // Acceptance criterion #7 covers "considered" sources. When both PAWWORK_CONFIG_DIR
    // and Global.Path.config have AGENTS.md, only the higher-priority one is loaded; the
    // other should appear as considered with a priority-skipped reason.
    await using fakeHome = await tmpdir()
    await using pawworkConfig = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# PawWork Profile Instructions")
      },
    })
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Global Instructions")
      },
    })
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const sources = yield* svc.sources()
                const pawworkAgents = path.resolve(path.join(pawworkConfig.path, "AGENTS.md"))
                const globalAgents = path.resolve(path.join(globalTmp.path, "AGENTS.md"))
                const loaded = sources.find((s) => s.status === "loaded" && s.path === pawworkAgents)
                const skipped = sources.find((s) => s.status === "considered" && s.path === globalAgents)
                expect(loaded).toBeDefined()
                expect(skipped).toBeDefined()
                if (skipped?.status === "considered") {
                  expect(skipped.reason).toContain("higher-priority")
                }
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("sources() reports project priority chain as loaded plus considered siblings", async () => {
    // When both AGENTS.md and CLAUDE.md exist in the project root, system() loads only
    // AGENTS.md. sources() must surface CLAUDE.md as considered with the priority reason
    // so debug output can explain the project fallback order from issue #230.
    await using fakeHome = await tmpdir()
    await using pawworkConfig = await tmpdir()
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Project AGENTS")
        await Bun.write(path.join(dir, "CLAUDE.md"), "# Project CLAUDE")
      },
    })

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const sources = yield* svc.sources()
                const agents = path.resolve(path.join(projectTmp.path, "AGENTS.md"))
                const claude = path.resolve(path.join(projectTmp.path, "CLAUDE.md"))
                const loaded = sources.find((s) => s.status === "loaded" && s.path === agents)
                const skipped = sources.find((s) => s.status === "considered" && s.path === claude)
                expect(loaded).toBeDefined()
                expect(skipped).toBeDefined()
                if (skipped?.status === "considered") {
                  expect(skipped.reason).toContain("higher-priority project")
                }
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("sources() downgrades empty AGENTS.md from loaded to considered", async () => {
    // system() drops empty/unreadable files from the prompt, so sources() must mirror
    // that or diagnostics will claim a file is loaded that the model never sees.
    await using fakeHome = await tmpdir()
    await using pawworkConfig = await tmpdir()
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "")
      },
    })

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const sources = yield* svc.sources()
                const projectAgents = path.resolve(path.join(projectTmp.path, "AGENTS.md"))
                const loaded = sources.find((s) => s.status === "loaded" && s.path === projectAgents)
                const considered = sources.find((s) => s.status === "considered" && s.path === projectAgents)
                expect(loaded).toBeUndefined()
                expect(considered).toBeDefined()
                if (considered?.status === "considered") {
                  expect(considered.reason).toMatch(/empty|unreadable/)
                }
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("sources() lists loaded project AGENTS.md", async () => {
    await using fakeHome = await tmpdir()
    await using pawworkConfig = await tmpdir()
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Project Instructions")
      },
    })

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const sources = yield* svc.sources()
                const projectAgents = path.resolve(path.join(projectTmp.path, "AGENTS.md"))
                const loaded = sources.find((s) => s.status === "loaded" && s.path === projectAgents)
                expect(loaded).toBeDefined()
                expect(loaded?.status).toBe("loaded")
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("ignores ~/.claude/CLAUDE.md global fallback in PawWork runtime mode", async () => {
    // Verifies acceptance criterion #5 of issue #230: PawWork no longer falls back
    // to global ~/.claude/CLAUDE.md as an instruction source. Project-level CLAUDE.md
    // (compatibility, criterion #6) is covered separately below.
    await using fakeHome = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".claude", "CLAUDE.md"), "# Global Claude Instructions")
      },
    })
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    delete process.env.PAWWORK_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const paths = yield* svc.systemPaths()
                const claudeFallback = path.resolve(path.join(fakeHome.path, ".claude", "CLAUDE.md"))
                expect(paths.has(claudeFallback)).toBe(false)
                expect(Array.from(paths).some((p) => p.endsWith(path.join(".claude", "CLAUDE.md")))).toBe(false)
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("fresh PawWork install loads no instruction sources when nothing is configured", async () => {
    // Acceptance criterion: with no project AGENTS.md/CLAUDE.md, no PawWork global,
    // and no ~/.claude/CLAUDE.md, the system surface is the bundled prompt only.
    await using fakeHome = await tmpdir()
    await using pawworkConfig = await tmpdir()
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const paths = yield* svc.systemPaths()
                expect(paths.size).toBe(0)
                const rules = yield* svc.system()
                expect(rules).toEqual([])
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("loads project AGENTS.md when present in PawWork runtime mode", async () => {
    await using fakeHome = await tmpdir()
    await using pawworkConfig = await tmpdir()
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Project Instructions")
      },
    })

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const paths = yield* svc.systemPaths()
                expect(paths.has(path.join(projectTmp.path, "AGENTS.md"))).toBe(true)
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("falls back to project CLAUDE.md when AGENTS.md is absent (compatibility)", async () => {
    // Acceptance criterion #6: project-level CLAUDE.md remains a compatibility
    // fallback when project AGENTS.md is absent. Distinct from the global ~/.claude
    // fallback which is removed.
    await using fakeHome = await tmpdir()
    await using pawworkConfig = await tmpdir()
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "CLAUDE.md"), "# Project Claude Instructions")
      },
    })

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const paths = yield* svc.systemPaths()
                expect(paths.has(path.join(projectTmp.path, "CLAUDE.md"))).toBe(true)
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("loads PawWork global AGENTS.md from PAWWORK_CONFIG_DIR", async () => {
    await using fakeHome = await tmpdir()
    await using pawworkConfig = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# PawWork Global Instructions")
      },
    })
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const paths = yield* svc.systemPaths()
                expect(paths.has(path.join(pawworkConfig.path, "AGENTS.md"))).toBe(true)
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("non-PawWork runtime keeps ~/.claude/CLAUDE.md fallback when flag unset", async () => {
    // Regression guard for the Runtime.isPawWork() gate: opencode CLI users on default
    // behavior should still get the Claude Code interop fallback. Catches accidental
    // condition inversion or future Runtime.isPawWork() changes.
    await using fakeHome = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".claude", "CLAUDE.md"), "# Global Claude Instructions")
      },
    })
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir()

    delete process.env.PAWWORK_RUNTIME_NAMESPACE
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    delete process.env.PAWWORK_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const paths = yield* svc.systemPaths()
                const claudeFallback = path.resolve(path.join(fakeHome.path, ".claude", "CLAUDE.md"))
                expect(paths.has(claudeFallback)).toBe(true)
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("resolves relative instruction paths from PAWWORK_CONFIG_DIR when project config is disabled", async () => {
    await using pawworkConfig = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "rules", "extra.md"), "# PawWork Relative Instructions")
      },
    })
    await using opencodeConfig = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "rules", "extra.md"), "# OpenCode Relative Instructions")
      },
    })
    await using globalTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "pawwork.json"), JSON.stringify({ instructions: ["rules/extra.md"] }))
      },
    })
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
    process.env.OPENCODE_CONFIG_DIR = opencodeConfig.path
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    const originalGlobalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalTmp.path

    try {
      await Instance.provide({
        directory: projectTmp.path,
        fn: () =>
          run(
            Instruction.Service.use((svc) =>
              Effect.gen(function* () {
                const rules = yield* svc.system()
                expect(rules).toContain(
                  `Instructions from: ${path.join(pawworkConfig.path, "rules", "extra.md")}\n# PawWork Relative Instructions`,
                )
                expect(rules.join("\n")).not.toContain("OpenCode Relative Instructions")
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })
})
