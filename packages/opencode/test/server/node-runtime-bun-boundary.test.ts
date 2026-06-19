import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Process } from "../../src/util/process"
import { tmpdir } from "../fixture/fixture"
import { withEmbeddedServerArtifactLock } from "../shared/embedded-server-artifact-lock"
import { expectModelsSnapshotUnchanged, writeCurrentModelsFixture } from "./models-snapshot-fixture"

const root = path.join(import.meta.dir, "../..")
const sourceRoot = path.join(root, "src")
const distEntry = path.join(root, "dist", "node", "node.js")

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const current = path.join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(current)
      if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) return [current]
      return []
    }),
  )
  return files.flat()
}

function normalizeRelative(file: string) {
  return path.relative(sourceRoot, file).split(path.sep).join("/")
}

function isBunRuntimeBoundary(file: string) {
  const relative = normalizeRelative(file)
  if (relative.endsWith(".bun.ts")) return false
  if (relative.startsWith("cli/")) return false
  return true
}

describe("node runtime Bun boundary", () => {
  test("keeps Node server source paths free of direct Bun globals", async () => {
    const violations: string[] = []
    for (const file of await sourceFiles(sourceRoot)) {
      if (!isBunRuntimeBoundary(file)) continue

      const relative = normalizeRelative(file)
      const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/)
      lines.forEach((line, index) => {
        if (!/\bBun\./.test(line)) return
        if (line.includes("typeof Bun")) return
        violations.push(`${relative}:${index + 1}: ${line.trim()}`)
      })
    }

    expect(violations).toEqual([])
  })

  test("built Node server can create a worktree through the experimental route", async () => {
    await withEmbeddedServerArtifactLock(async () => {
      await using tmp = await tmpdir({ git: true })
      const modelsFixture = writeCurrentModelsFixture(root, tmp.path)
      const runtimeRoot = path.join(tmp.path, "runtime")
      const runtimeHome = path.join(runtimeRoot, "home")
      const isolatedEnv = {
        ...process.env,
        MODELS_DEV_API_JSON: modelsFixture.fixture,
        HOME: runtimeHome,
        USERPROFILE: runtimeHome,
        XDG_DATA_HOME: path.join(runtimeRoot, "share"),
        XDG_CACHE_HOME: path.join(runtimeRoot, "cache"),
        XDG_CONFIG_HOME: path.join(runtimeRoot, "config"),
        XDG_STATE_HOME: path.join(runtimeRoot, "state"),
        OPENCODE_TEST_HOME: runtimeHome,
        OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(runtimeRoot, "managed"),
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_DB: ":memory:",
      }

      await Promise.all(
        [
          isolatedEnv.HOME,
          isolatedEnv.XDG_DATA_HOME,
          isolatedEnv.XDG_CACHE_HOME,
          isolatedEnv.XDG_CONFIG_HOME,
          isolatedEnv.XDG_STATE_HOME,
          isolatedEnv.OPENCODE_TEST_MANAGED_CONFIG_DIR,
        ].map((dir) => fs.mkdir(dir, { recursive: true })),
      )

      await Process.run([process.execPath, "run", "build:embedded-server"], {
        cwd: root,
        env: isolatedEnv,
      })
      expectModelsSnapshotUnchanged(modelsFixture)

      const script = `
        import { writeFileSync } from "node:fs"
        import { request as httpRequest } from "node:http"
        import { Server, Log } from ${JSON.stringify(pathToFileURL(distEntry).href)}

        const password = process.env.OPENCODE_SERVER_PASSWORD
        const directory = process.env.TEST_DIRECTORY
        const outputFile = process.env.TEST_OUTPUT_FILE
        if (!password) throw new Error("missing OPENCODE_SERVER_PASSWORD")
        if (!directory) throw new Error("missing TEST_DIRECTORY")
        if (!outputFile) throw new Error("missing TEST_OUTPUT_FILE")

        await Log.init({ level: "DEBUG", print: false })
        const listener = await Server.listen({ port: 0, hostname: "127.0.0.1" })
        const auth = "Basic " + Buffer.from(\`opencode:\${password}\`).toString("base64")

        const request = (pathname, init = {}) => new Promise((resolve, reject) => {
          const url = new URL(pathname, listener.url)
          url.searchParams.set("directory", directory)

          const req = httpRequest(
            url,
            {
              agent: false,
              method: init.method ?? "GET",
              headers: {
                authorization: auth,
                connection: "close",
                ...(init.body ? { "content-type": "application/json" } : {}),
              },
            },
            (response) => {
              const chunks = []
              response.on("data", (chunk) => chunks.push(chunk))
              response.on("error", reject)
              response.on("end", () => {
                resolve({
                  status: response.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                })
              })
            },
          )

          req.on("error", reject)
          if (init.body) req.write(init.body)
          req.end()
        })

        try {
          const result = await request("/experimental/worktree", {
            method: "POST",
            body: JSON.stringify({ name: "node-runtime-smoke" }),
          })
          writeFileSync(outputFile, JSON.stringify(result))
        } finally {
          await listener.stop(true)
        }

        await new Promise((resolve) => setTimeout(resolve, 50))
        process.exit(0)
      `

      const outputFile = path.join(tmp.path, "embedded-worktree-result.json")
      const result = await Process.run(["node", "--input-type=module", "-e", script], {
        cwd: root,
        env: {
          ...isolatedEnv,
          OPENCODE_SERVER_USERNAME: "opencode",
          OPENCODE_SERVER_PASSWORD: "testpass",
          TEST_DIRECTORY: tmp.path,
          TEST_OUTPUT_FILE: outputFile,
        },
      })

      expect(result.stdout.toString()).toBe("")
      const output = JSON.parse(await fs.readFile(outputFile, "utf8")) as {
        status: number
        body: string
      }
      const body = JSON.parse(output.body) as { name: string; directory: string }

      expect(output.status).toBe(200)
      expect(body.name).toBe("node-runtime-smoke")
      expect(body.directory).toContain(`${path.sep}.worktrees${path.sep}`)
      expect(path.basename(body.directory)).toBe("node-runtime-smoke")
    })
  }, 60_000)
})
