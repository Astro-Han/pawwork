import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instruction, projectFiles } from "../../src/session/instruction"
import { Config } from "../../src/config"
import type { MessageV2 } from "../../src/session/message-v2"
import { Instance } from "../../src/project/instance"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../fixture/fixture"

const run = <A>(effect: Effect.Effect<A, any, Instruction.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Instruction.defaultLayer)))

beforeEach(async () => {
  await Config.invalidate(true)
})

afterEach(async () => {
  await Config.invalidate(true)
})

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

  test("nearby instruction lookup skips directories named AGENTS.md", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "subdir", "AGENTS.md"), { recursive: true })
        await Bun.write(path.join(dir, "subdir", "CLAUDE.md"), "# Subdir Claude Instructions")
        await Bun.write(path.join(dir, "subdir", "nested", "file.ts"), "const x = 1")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const results = yield* svc.resolve(
                [],
                path.join(tmp.path, "subdir", "nested", "file.ts"),
                MessageID.make("message-test-dir-agents"),
              )
              expect(results.length).toBe(1)
              expect(results[0].filepath).toBe(path.join(tmp.path, "subdir", "CLAUDE.md"))
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
    pawworkHome: process.env.PAWWORK_HOME,
    pawworkConfigDir: process.env.PAWWORK_CONFIG_DIR,
    runtimeNamespace: process.env.PAWWORK_RUNTIME_NAMESPACE,
    disableProjectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
    testHome: process.env.OPENCODE_TEST_HOME,
    disableClaudePrompt: process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT,
  }

  afterEach(() => {
    if (original.opencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = original.opencodeConfigDir
    if (original.pawworkHome === undefined) delete process.env.PAWWORK_HOME
    else process.env.PAWWORK_HOME = original.pawworkHome
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

  test("prefers PAWWORK_HOME AGENTS.md over PAWWORK_CONFIG_DIR and legacy global", async () => {
    await using homeTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# PawWork Home Instructions")
      },
    })
    await using envTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# PawWork Env Instructions")
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
    process.env.PAWWORK_HOME = homeTmp.path
    process.env.PAWWORK_CONFIG_DIR = envTmp.path
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
                expect(paths.has(path.join(homeTmp.path, "AGENTS.md"))).toBe(true)
                expect(paths.has(path.join(envTmp.path, "AGENTS.md"))).toBe(false)
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

  test("sources() stops global instruction discovery at the first existing candidate", async () => {
    // systemPaths() stops at the first existing global candidate even if later candidates
    // also exist. sources() must model that same boundary so diagnostics cannot imply a
    // lower-priority file was part of prompt construction.
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
                expect(skipped).toBeUndefined()
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("sources() skips non-file global instruction candidates", async () => {
    await using fakeHome = await tmpdir()
    await using pawworkConfig = await tmpdir({
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "AGENTS.md"))
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
                const considered = sources.find((s) => s.status === "considered" && s.path === pawworkAgents)
                const loaded = sources.find((s) => s.status === "loaded" && s.path === globalAgents)
                expect(considered).toBeDefined()
                if (considered?.status === "considered") expect(considered.reason).toBe("not a file")
                expect(loaded).toBeDefined()
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("sources() stops project instruction discovery at the first existing basename", async () => {
    // When both AGENTS.md and CLAUDE.md exist in the project root, systemPaths() stops at
    // AGENTS.md. sources() follows that same boundary instead of scanning lower-priority
    // project basenames.
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
                expect(skipped).toBeUndefined()
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

  test("sources() does not load lower-priority project file when higher-priority file exists empty", async () => {
    await using fakeHome = await tmpdir()
    await using pawworkConfig = await tmpdir()
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "")
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
                const rules = yield* svc.system()
                const sources = yield* svc.sources()
                const agents = path.resolve(path.join(projectTmp.path, "AGENTS.md"))
                const claude = path.resolve(path.join(projectTmp.path, "CLAUDE.md"))

                expect(rules.some((rule) => rule.includes("# Project CLAUDE"))).toBe(false)
                expect(sources.find((s) => s.status === "loaded" && s.path === claude)).toBeUndefined()
                const considered = sources.find((s) => s.status === "considered" && s.path === agents)
                expect(considered).toBeDefined()
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
    }
  })

  test("systemPaths() skips project instruction candidates that are not files", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(path.join(tmp.path, "AGENTS.md"))
    await fs.writeFile(path.join(tmp.path, "CLAUDE.md"), "claude instructions")

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const paths = yield* svc.systemPaths()
              expect(paths.has(path.join(tmp.path, "AGENTS.md"))).toBe(false)
              expect(paths.has(path.join(tmp.path, "CLAUDE.md"))).toBe(true)
            }),
          ),
        ),
    })
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

  test("sources() reports config.instructions URL in diagnostics regardless of fetch outcome", async () => {
    // Acceptance criterion #7: URL contributions to system() must also appear in the
    // diagnostic so prompt and diagnostic stay in lockstep. Uses an unreachable URL
    // so the assertion accepts either fetch outcome deterministically.
    const originalConfig = process.env.OPENCODE_CONFIG_CONTENT
    await using fakeHome = await tmpdir()
    await using pawworkConfig = await tmpdir()
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT

    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      instructions: ["http://127.0.0.1:1/never-listening.md"],
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
                const sources = yield* svc.sources()
                const url = "http://127.0.0.1:1/never-listening.md"
                const urlEntry = sources.find((s) => s.path === url)
                expect(urlEntry).toBeDefined()
                if (urlEntry?.status === "considered") {
                  expect(urlEntry.reason).toMatch(/fetch failed|empty body/)
                }
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
      if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
      else process.env.OPENCODE_CONFIG_CONTENT = originalConfig
    }
  })

  test("sources() reports local file paths from config.instructions", async () => {
    // Acceptance criterion #7 / parity with system(): non-URL config.instructions
    // entries are glob-resolved into the system prompt; the diagnostic must mirror
    // that so debugging reflects what the model actually sees.
    const originalConfig = process.env.OPENCODE_CONFIG_CONTENT
    await using fakeHome = await tmpdir()
    await using pawworkConfig = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "rules", "extra.md"), "# PawWork Relative Instructions")
      },
    })
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = fakeHome.path
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT

    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      instructions: ["rules/extra.md"],
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
                const sources = yield* svc.sources()
                const expected = path.resolve(path.join(pawworkConfig.path, "rules", "extra.md"))
                const loaded = sources.find((s) => s.status === "loaded" && s.path === expected)
                expect(loaded).toBeDefined()
              }),
            ),
          ),
      })
    } finally {
      ;(Global.Path as { config: string }).config = originalGlobalConfig
      if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
      else process.env.OPENCODE_CONFIG_CONTENT = originalConfig
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
        await Bun.write(path.join(dir, "pawwork.json"), JSON.stringify({ instructions: ["rules/extra.md"] }))
      },
    })
    await using opencodeConfig = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "rules", "extra.md"), "# OpenCode Relative Instructions")
      },
    })
    await using globalTmp = await tmpdir()
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
    process.env.OPENCODE_CONFIG_DIR = opencodeConfig.path
    delete process.env.PAWWORK_HOME
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_CONTENT
    await Config.invalidate(true)
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

  test("resolves relative instruction paths from PAWWORK_HOME when project config is disabled", async () => {
    await using pawworkHome = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "rules", "home-extra.md"), "# PawWork Home Relative Instructions")
        await Bun.write(path.join(dir, "pawwork.json"), JSON.stringify({ instructions: ["rules/home-extra.md"] }))
      },
    })
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
    process.env.PAWWORK_HOME = pawworkHome.path
    delete process.env.PAWWORK_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_CONTENT
    await Config.invalidate(true)

    await Instance.provide({
      directory: projectTmp.path,
      fn: () =>
        run(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const rules = yield* svc.system()
              expect(rules).toContain(
                `Instructions from: ${path.join(pawworkHome.path, "rules", "home-extra.md")}\n# PawWork Home Relative Instructions`,
              )
            }),
          ),
        ),
    })
  })

  test("resolves relative instruction paths from PAWWORK_HOME over PAWWORK_CONFIG_DIR when project config is disabled", async () => {
    await using pawworkHome = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "rules", "home-wins.md"), "# Home Wins")
        await Bun.write(path.join(dir, "pawwork.json"), JSON.stringify({ instructions: ["rules/home-wins.md"] }))
      },
    })
    await using pawworkConfig = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "rules", "legacy-env.md"), "# Legacy Env")
        await Bun.write(path.join(dir, "pawwork.json"), JSON.stringify({ instructions: ["rules/legacy-env.md"] }))
      },
    })
    await using projectTmp = await tmpdir()

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
    process.env.PAWWORK_HOME = pawworkHome.path
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_CONTENT
    await Config.invalidate(true)

    await Instance.provide({
      directory: projectTmp.path,
      fn: () =>
        run(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const rules = yield* svc.system()
              expect(rules).toContain(`Instructions from: ${path.join(pawworkHome.path, "rules", "home-wins.md")}\n# Home Wins`)
              expect(rules.join("\n")).not.toContain("Legacy Env")
            }),
          ),
        ),
    })
  })

  test("resolves relative instruction paths from fallback PawWork config when primary has no config", async () => {
    await using pawworkHome = await tmpdir()
    await using pawworkConfig = await tmpdir()
    await using projectTmp = await tmpdir()
    await fs.mkdir(path.join(pawworkConfig.path, "rules"), { recursive: true })
    await Bun.write(path.join(pawworkConfig.path, "rules", "fallback.md"), "# Fallback Config")
    await Bun.write(path.join(pawworkConfig.path, "pawwork.json"), JSON.stringify({ instructions: ["rules/fallback.md"] }))

    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
    process.env.PAWWORK_HOME = pawworkHome.path
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path
    delete process.env.OPENCODE_CONFIG_CONTENT
    await Config.invalidate(true)

    await Instance.provide({
      directory: projectTmp.path,
      fn: () =>
        run(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const rules = yield* svc.system()
              expect(rules).toContain(
                `Instructions from: ${path.join(pawworkConfig.path, "rules", "fallback.md")}\n# Fallback Config`,
              )
            }),
          ),
        ),
    })
  })
})

describe("Instruction findUp lookup errors", () => {
  // findUp walks the directory tree calling fs.exists, which propagates I/O errors
  // such as EACCES on an unreadable ancestor. Every other I/O in instruction.ts
  // degrades to an empty result on failure; the project-level findUp walk must do
  // the same so a single unreadable ancestor cannot crash prompt construction.
  const failingFindUpFs = Layer.effect(
    AppFileSystem.Service,
    Effect.gen(function* () {
      const real = yield* AppFileSystem.Service
      return AppFileSystem.Service.of({
        ...real,
        findUp: () => Effect.fail(new AppFileSystem.FileSystemError({ method: "findUp" })),
      })
    }),
  ).pipe(Layer.provide(AppFileSystem.defaultLayer))

  const failingLayer = Instruction.layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(failingFindUpFs),
    Layer.provide(FetchHttpClient.layer),
  )

  const runFailing = <A>(effect: Effect.Effect<A, any, Instruction.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(failingLayer)))

  let originalDisableProjectConfig: string | undefined
  beforeEach(() => {
    originalDisableProjectConfig = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
  })
  afterEach(() => {
    if (originalDisableProjectConfig === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = originalDisableProjectConfig
  })

  test("systemPaths() degrades to no project match when findUp fails instead of crashing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Root Instructions")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        runFailing(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const paths = yield* svc.systemPaths()
              // The project AGENTS.md would have been discovered by findUp; with findUp
              // failing the walk yields nothing rather than propagating the error.
              expect(paths.has(path.join(tmp.path, "AGENTS.md"))).toBe(false)
            }),
          ),
        ),
    })
  })

  test("sources() does not crash when findUp fails", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "AGENTS.md"), "# Root Instructions")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        runFailing(
          Instruction.Service.use((svc) =>
            Effect.gen(function* () {
              const sources = yield* svc.sources()
              expect(Array.isArray(sources)).toBe(true)
            }),
          ),
        ),
    })
  })
})
