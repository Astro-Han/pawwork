import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { pathToFileURL } from "url"
import { Process } from "../../src/util/process"
import { tmpdir } from "../fixture/fixture"
import { withEmbeddedServerArtifactLock } from "../shared/embedded-server-artifact-lock"
import { expectModelsSnapshotUnchanged, writeCurrentModelsFixture } from "./models-snapshot-fixture"

const root = path.join(import.meta.dir, "../..")
const distEntry = path.join(root, "dist", "node", "node.js")

describe("built node server skill bootstrap", () => {
  test("built node server serves /agent and /command when builtin skill roots are resolved implicitly", async () => {
    await withEmbeddedServerArtifactLock(async () => {
      await using tmp = await tmpdir()
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

      // This test exits the child process explicitly. On Windows Node 24, fetch
      // can abort during process.exit() handle teardown and hide the bootstrap result.
      const request = (pathname) => new Promise((resolve, reject) => {
        const url = new URL(pathname, listener.url)
        url.searchParams.set("directory", directory)

        const req = httpRequest(
          url,
          {
            agent: false,
            headers: {
              authorization: auth,
              connection: "close",
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
        req.end()
      })

      let exitCode = 0
      try {
        const result = {
          agent: await request("/agent"),
          command: await request("/command"),
        }
        writeFileSync(outputFile, JSON.stringify(result))
        if (result.agent.status !== 200 || result.command.status !== 200) {
          exitCode = 1
        }
      } finally {
        await listener.stop(true)
      }

      // Give Windows a moment to finish async handle teardown before exiting the child process.
      await new Promise((resolve) => setTimeout(resolve, 50))
      process.exit(exitCode)
    `

      const outputFile = path.join(tmp.path, "embedded-server-result.json")
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
        agent: { status: number; body: string }
        command: { status: number; body: string }
      }

      expect(output.agent.status).toBe(200)
      expect(output.command.status).toBe(200)
    })
  }, 60_000)
})
