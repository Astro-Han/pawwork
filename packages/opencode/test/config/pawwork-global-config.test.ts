import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Option } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Account } from "../../src/account"
import { Auth } from "../../src/auth"
import { Config, ConfigManaged } from "../../src/config"
import { ConfigPaths } from "../../src/config/paths"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "../../src/filesystem"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const emptyAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})

const emptyAuth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({}),
})

const layer = Config.layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(emptyAuth),
  Layer.provide(emptyAccount),
  Layer.provideMerge(infra),
)

const load = () => Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(layer)))
const save = (config: Config.Info) =>
  Effect.runPromise(Config.Service.use((svc) => svc.update(config)).pipe(Effect.scoped, Effect.provide(layer)))
const saveGlobal = (config: Config.Info) =>
  Effect.runPromise(Config.Service.use((svc) => svc.updateGlobal(config)).pipe(Effect.scoped, Effect.provide(layer)))
const clear = (wait = false) =>
  Effect.runPromise(Config.Service.use((svc) => svc.invalidate(wait)).pipe(Effect.scoped, Effect.provide(layer)))
const listConfigDirs = (directory: string, worktree: string) =>
  Effect.runPromise(ConfigPaths.directories(directory, worktree).pipe(Effect.provide(AppFileSystem.defaultLayer)))

const originalRuntimeNamespace = process.env.PAWWORK_RUNTIME_NAMESPACE

beforeEach(async () => {
  process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
  await clear(true)
})

afterEach(async () => {
  await Instance.disposeAll()
  await clear(true)
  if (originalRuntimeNamespace === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
  else process.env.PAWWORK_RUNTIME_NAMESPACE = originalRuntimeNamespace
})

describe("default OpenCode config compatibility", () => {
  test("keeps OPENCODE_CONFIG_DIR outside PawWork runtime mode", async () => {
    await using opencodeConfig = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousOpenCode = process.env.OPENCODE_CONFIG_DIR

    delete process.env.PAWWORK_RUNTIME_NAMESPACE
    process.env.OPENCODE_CONFIG_DIR = opencodeConfig.path

    try {
      const dirs = await listConfigDirs(project.path, project.path)
      expect(dirs).toContain(opencodeConfig.path)
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
      if (previousOpenCode === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousOpenCode
    }
  })

  test("keeps OpenCode managed config defaults outside PawWork runtime mode", () => {
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousManaged = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
    delete process.env.PAWWORK_RUNTIME_NAMESPACE
    delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR

    try {
      const managed = ConfigManaged.managedConfigDir()
      expect(path.basename(managed)).toBe("opencode")
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
      if (previousManaged === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
      else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previousManaged
    }
  })

  test("PawWork runtime mode computes Global config under PawWork before module load", async () => {
    await using root = await tmpdir()
    const project = path.join(root.path, "project")
    const script = `
      process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
      process.env.XDG_CONFIG_HOME = ${JSON.stringify(root.path)}
      const { ConfigPaths } = await import("./src/config/paths.ts")
      const { AppFileSystem } = await import("./src/filesystem/index.ts")
      const { Effect } = await import("effect")
      const dirs = await Effect.runPromise(
        ConfigPaths.directories(${JSON.stringify(project)}, ${JSON.stringify(project)}).pipe(Effect.provide(AppFileSystem.defaultLayer)),
      )
      console.log(JSON.stringify(dirs[0]))
    `
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--eval", script],
      cwd: path.join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })

    if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString())
    expect(JSON.parse(Buffer.from(result.stdout).toString())).toBe(path.join(root.path, "pawwork"))
  })

  test("keeps legacy project .opencode config.json compatibility", async () => {
    await using project = await tmpdir({ git: true })

    const configDir = path.join(project.path, ".opencode")
    await fs.mkdir(configDir, { recursive: true })
    await Filesystem.write(path.join(configDir, "config.json"), JSON.stringify({ model: "compat/config" }))

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const config = await load()
        expect(config.model).toBe("compat/config")
      },
    })
  })

  test("OpenCode runtime ignores PawWork project config aliases", async () => {
    await using project = await tmpdir({ git: true })
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    delete process.env.PAWWORK_RUNTIME_NAMESPACE

    try {
      await Filesystem.write(path.join(project.path, "pawwork.json"), JSON.stringify({ model: "leaked/root" }))
      await fs.mkdir(path.join(project.path, ".pawwork"), { recursive: true })
      await Filesystem.write(
        path.join(project.path, ".pawwork", "pawwork.json"),
        JSON.stringify({ model: "leaked/directory" }),
      )

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).not.toBe("leaked/root")
          expect(config.model).not.toBe("leaked/directory")
        },
      })
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
    }
  })

  test("OpenCode runtime ignores PawWork global config aliases", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousConfig = Global.Path.config
    delete process.env.PAWWORK_RUNTIME_NAMESPACE
    ;(Global.Path as { config: string }).config = global.path

    try {
      await Filesystem.write(path.join(global.path, "pawwork.json"), JSON.stringify({ model: "leaked/global" }))
      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).not.toBe("leaked/global")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
    }
  })
})

describe("PawWork global config isolation", () => {
  test("does not discover home-level .opencode config implicitly", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path

    try {
      const homeConfigDir = path.join(home.path, ".opencode")
      await fs.mkdir(homeConfigDir, { recursive: true })
      await Filesystem.write(path.join(homeConfigDir, "opencode.json"), JSON.stringify({ model: "leaked/model" }))

      const dirs = await listConfigDirs(project.path, project.path)

      expect(dirs).not.toContain(homeConfigDir)

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).not.toBe("leaked/model")
        },
      })
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = previousHome
    }
  })

  test("ignores OPENCODE_CONFIG_DIR as an implicit OpenCode global config path", async () => {
    await using opencodeConfig = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousOpenCode = process.env.OPENCODE_CONFIG_DIR
    const previousPawWork = process.env.PAWWORK_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = opencodeConfig.path
    delete process.env.PAWWORK_CONFIG_DIR

    try {
      await Filesystem.write(path.join(opencodeConfig.path, "opencode.json"), JSON.stringify({ model: "leaked/env" }))

      const dirs = await listConfigDirs(project.path, project.path)
      expect(dirs).not.toContain(opencodeConfig.path)

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).not.toBe("leaked/env")
        },
      })
    } finally {
      if (previousOpenCode === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousOpenCode
      if (previousPawWork === undefined) delete process.env.PAWWORK_CONFIG_DIR
      else process.env.PAWWORK_CONFIG_DIR = previousPawWork
    }
  })

  test("PAWWORK_CONFIG_DIR reads PawWork filenames and ignores OpenCode filenames", async () => {
    await using pawworkConfig = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousOpenCode = process.env.OPENCODE_CONFIG_DIR
    const previousPawWork = process.env.PAWWORK_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path

    try {
      await Filesystem.write(path.join(pawworkConfig.path, "opencode.json"), JSON.stringify({ model: "leaked/env" }))
      await Filesystem.write(path.join(pawworkConfig.path, "pawwork.json"), JSON.stringify({ model: "expected/model" }))

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).toBe("expected/model")
        },
      })
    } finally {
      if (previousOpenCode === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousOpenCode
      if (previousPawWork === undefined) delete process.env.PAWWORK_CONFIG_DIR
      else process.env.PAWWORK_CONFIG_DIR = previousPawWork
    }
  })

  test("PAWWORK_CONFIG_DIR with only opencode.json does not affect config", async () => {
    await using pawworkConfig = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousOpenCode = process.env.OPENCODE_CONFIG_DIR
    const previousPawWork = process.env.PAWWORK_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path

    try {
      await Filesystem.write(path.join(pawworkConfig.path, "opencode.json"), JSON.stringify({ model: "leaked/env" }))

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).not.toBe("leaked/env")
        },
      })
    } finally {
      if (previousOpenCode === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousOpenCode
      if (previousPawWork === undefined) delete process.env.PAWWORK_CONFIG_DIR
      else process.env.PAWWORK_CONFIG_DIR = previousPawWork
    }
  })

  test("loads project .pawwork config directories", async () => {
    await using project = await tmpdir({ git: true })
    const pawworkDir = path.join(project.path, ".pawwork")
    await fs.mkdir(pawworkDir, { recursive: true })
    await Filesystem.write(path.join(pawworkDir, "pawwork.json"), JSON.stringify({ model: "project/pawwork" }))

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const dirs = await listConfigDirs(project.path, project.path)
        expect(dirs).toContain(pawworkDir)

        const config = await load()
        expect(config.model).toBe("project/pawwork")
      },
    })
  })

  test("project .opencode directories stay read-only for dependency installs", async () => {
    await using project = await tmpdir({ git: true })
    const opencodeDir = path.join(project.path, ".opencode")
    await fs.mkdir(opencodeDir, { recursive: true })
    await Filesystem.write(path.join(opencodeDir, "opencode.json"), JSON.stringify({ model: "compat/model" }))

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const config = await load()
        expect(config.model).toBe("compat/model")

        expect(await Bun.file(path.join(opencodeDir, "package.json")).exists()).toBeFalse()
        expect(await Bun.file(path.join(opencodeDir, ".gitignore")).exists()).toBeFalse()
      },
    })
  })

  test("project config update writes pawwork.json and reloads it", async () => {
    await using project = await tmpdir({ git: true })

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await save({ model: "project/model" })

        expect(await Bun.file(path.join(project.path, "config.json")).exists()).toBeFalse()
        expect(await Bun.file(path.join(project.path, "pawwork.json")).exists()).toBeTrue()

        const after = await load()
        expect(after.model).toBe("project/model")
      },
    })
  })

  test("project config update writes to the active PawWork jsonc file", async () => {
    await using project = await tmpdir({ git: true })

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await Filesystem.write(path.join(project.path, "pawwork.json"), JSON.stringify({ model: "json/model" }))
        await Filesystem.write(path.join(project.path, "pawwork.jsonc"), JSON.stringify({ model: "jsonc/model" }))

        const before = await load()
        expect(before.model).toBe("jsonc/model")

        await save({ model: "updated/project" })
        const after = await load()
        expect(after.model).toBe("updated/project")
        expect(JSON.parse(await Bun.file(path.join(project.path, "pawwork.jsonc")).text()).model).toBe(
          "updated/project",
        )
      },
    })
  })

  test("global config update writes pawwork.json and ignores app-level opencode.json", async () => {
    await using project = await tmpdir({ git: true })
    await using global = await tmpdir()
    const globalDir = global.path
    const previousConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalDir

    try {
      await Instance.provide({
        directory: project.path,
        fn: async () => {
          await Filesystem.write(path.join(globalDir, "opencode.json"), JSON.stringify({ model: "leaked/global" }))

          const before = await load()
          expect(before.model).not.toBe("leaked/global")

          await saveGlobal({ model: "test/model" })
          const configPath = path.join(globalDir, "pawwork.json")
          expect(await Bun.file(configPath).exists()).toBeTrue()
          expect(JSON.parse(await Bun.file(configPath).text()).model).toBe("test/model")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("global config update writes to the active PawWork config file", async () => {
    await using project = await tmpdir({ git: true })
    await using global = await tmpdir()
    const globalDir = global.path
    const previousConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = globalDir

    try {
      await Instance.provide({
        directory: project.path,
        fn: async () => {
          await Filesystem.write(path.join(globalDir, "pawwork.json"), JSON.stringify({ model: "json/model" }))
          await Filesystem.write(path.join(globalDir, "pawwork.jsonc"), JSON.stringify({ model: "jsonc/model" }))

          const before = await load()
          expect(before.model).toBe("jsonc/model")

          await saveGlobal({ model: "updated/model" })
          const after = await load()
          expect(after.model).toBe("updated/model")
          expect(JSON.parse(await Bun.file(path.join(globalDir, "pawwork.jsonc")).text()).model).toBe("updated/model")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("managed config defaults use PawWork-owned locations", () => {
    const previous = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
    delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR

    try {
      const managed = ConfigManaged.managedConfigDir()
      expect(path.basename(managed)).toBe("pawwork")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
      else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previous
    }
  })

  test("managed config ignores opencode.json in PawWork runtime mode", async () => {
    await using managed = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previous = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
    process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = managed.path

    try {
      await Filesystem.write(path.join(managed.path, "opencode.json"), JSON.stringify({ model: "leaked/managed" }))
      await Filesystem.write(path.join(managed.path, "pawwork.json"), JSON.stringify({ model: "expected/managed" }))

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).toBe("expected/managed")
        },
      })
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
      else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previous
    }
  })
})
