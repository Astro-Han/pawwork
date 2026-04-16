import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Process } from "../../src/util/process"
import { tmpdir } from "../fixture/fixture"
import { withEmbeddedServerArtifactLock } from "../shared/embedded-server-artifact-lock"

const root = path.join(import.meta.dir, "../..")
const distEntry = path.join(root, "dist", "node", "node.js")

describe("built node server skill bootstrap", () => {
  test("built node server serves /agent and /command when builtin skill roots are resolved implicitly", async () => {
    await withEmbeddedServerArtifactLock(async () => {
      await using tmp = await tmpdir()

      await Process.run([process.execPath, "run", "build:embedded-server"], {
        cwd: root,
      })

      const script = `
      import { Server, Log } from ${JSON.stringify(pathToFileURL(distEntry).href)}

      const password = process.env.OPENCODE_SERVER_PASSWORD
      const directory = process.env.TEST_DIRECTORY
      if (!password) throw new Error("missing OPENCODE_SERVER_PASSWORD")
      if (!directory) throw new Error("missing TEST_DIRECTORY")

      await Log.init({ level: "DEBUG", print: false })
      const listener = await Server.listen({ port: 0, hostname: "127.0.0.1" })
      const auth = "Basic " + Buffer.from(\`opencode:\${password}\`).toString("base64")

      const request = async (pathname) => {
        const url = new URL(pathname, listener.url)
        url.searchParams.set("directory", directory)
        const response = await fetch(url, {
          headers: {
            authorization: auth,
          },
        })
        return {
          status: response.status,
          body: await response.text(),
        }
      }

      let exitCode = 0
      try {
        const result = {
          agent: await request("/agent"),
          command: await request("/command"),
        }
        console.log(JSON.stringify(result))
        if (result.agent.status !== 200 || result.command.status !== 200) {
          exitCode = 1
        }
      } finally {
        await listener.stop(true)
      }

      process.exit(exitCode)
    `

      const result = await Process.run(["node", "--input-type=module", "-e", script], {
        cwd: root,
        env: {
          ...process.env,
          OPENCODE_SERVER_USERNAME: "opencode",
          OPENCODE_SERVER_PASSWORD: "testpass",
          TEST_DIRECTORY: tmp.path,
        },
      })

      const output = JSON.parse(result.stdout.toString().trim()) as {
        agent: { status: number; body: string }
        command: { status: number; body: string }
      }

      expect(output.agent.status).toBe(200)
      expect(output.command.status).toBe(200)
    })
  }, 60_000)
})
