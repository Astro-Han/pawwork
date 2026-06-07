import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

type SpawnResult = string | { code: number; stdout?: string; stderr?: string }

function mockSpawner(handler: (cmd: string, args: readonly string[]) => SpawnResult = () => "") {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => SpawnResult,
) {
  return Installation.layer.pipe(Layer.provide(mockHttpClient(httpHandler)), Layer.provide(mockSpawner(spawnHandler)))
}

describe("installation", () => {
  describe("latest", () => {
    test("reads release version from GitHub releases", async () => {
      const layer = testLayer(() => jsonResponse({ tag_name: "v1.2.3" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("unknown")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.2.3")
    })

    test("strips v prefix from GitHub release tag", async () => {
      const layer = testLayer(() => jsonResponse({ tag_name: "v4.0.0-beta.1" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("curl")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("4.0.0-beta.1")
    })

    test("reads npm registry versions", async () => {
      const layer = testLayer(
        () => jsonResponse({ version: "1.5.0" }),
        (cmd, args) => {
          if (cmd === "npm" && args.includes("registry")) return "https://registry.npmjs.org\n"
          return ""
        },
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("npm")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.5.0")
    })

    test("reads npm registry versions for bun method", async () => {
      const layer = testLayer(
        () => jsonResponse({ version: "1.6.0" }),
        () => "",
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("bun")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.6.0")
    })

    test("reads scoop manifest versions", async () => {
      const layer = testLayer(() => jsonResponse({ version: "2.3.4" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("scoop")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("2.3.4")
    })

    test("reads chocolatey feed versions", async () => {
      const layer = testLayer(() => jsonResponse({ d: { results: [{ Version: "3.4.5" }] } }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("choco")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("3.4.5")
    })

    test("reads brew formulae API versions", async () => {
      const layer = testLayer(
        () => jsonResponse({ versions: { stable: "2.0.0" } }),
        (cmd, args) => {
          // getBrewFormula: return core formula (no tap)
          if (cmd === "brew" && args.includes("--formula") && args.includes("anomalyco/tap/opencode")) return ""
          if (cmd === "brew" && args.includes("--formula") && args.includes("opencode")) return "opencode"
          return ""
        },
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("brew")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("2.0.0")
    })

    test("reads brew tap info JSON via CLI", async () => {
      const brewInfoJson = JSON.stringify({
        formulae: [{ versions: { stable: "2.1.0" } }],
      })
      const layer = testLayer(
        () => jsonResponse({}), // HTTP not used for tap formula
        (cmd, args) => {
          if (cmd === "brew" && args.includes("anomalyco/tap/opencode") && args.includes("--formula")) return "opencode"
          if (cmd === "brew" && args.includes("--json=v2")) return brewInfoJson
          return ""
        },
      )

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("brew")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("2.1.0")
    })
  })

  describe("upgrade", () => {
    test("returns a sanitized typed error for a failed package upgrade", async () => {
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd) => (cmd === "npm" ? { code: 1, stderr: "token=secret command output" } : ""),
      )

      const error = await Effect.runPromise(
        Installation.Service.use((svc) => svc.upgrade("npm", "9.9.9")).pipe(Effect.provide(layer), Effect.flip),
      )
      expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
      expect(error.stderr).toBe("Upgrade failed for npm (exit code 1).")
      expect(error.message).toBe(error.stderr) // desktop API surfaces err.message
      expect(error.stderr).not.toContain("secret")
    })

    test("returns a sanitized typed error when the curl install script exits non-zero", async () => {
      const layer = testLayer(
        () => new Response("install script with token=secret", { status: 200 }),
        (cmd) => (cmd === "bash" ? { code: 1, stderr: "script output with token=secret" } : ""),
      )

      const error = await Effect.runPromise(
        Installation.Service.use((svc) => svc.upgrade("curl", "9.9.9")).pipe(Effect.provide(layer), Effect.flip),
      )
      expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
      expect(error.stderr).toBe("Upgrade failed for curl (exit code 1).")
      expect(error.message).toBe(error.stderr)
      expect(error.stderr).not.toContain("secret")
    })

    test("types a curl install-script fetch failure instead of dying", async () => {
      // Non-2xx makes httpOk fail; the mapError must turn that defect into a typed UpgradeFailedError.
      const layer = testLayer(() => new Response("not found", { status: 404 }))

      const error = await Effect.runPromise(
        Installation.Service.use((svc) => svc.upgrade("curl", "9.9.9")).pipe(Effect.provide(layer), Effect.flip),
      )
      expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
      expect(error.stderr).toBe("Upgrade failed for curl.")
      expect(error.message).toBe(error.stderr)
    })

    test("preserves the choco elevated-shell hint and never leaks raw stderr", async () => {
      const layer = testLayer(
        () => jsonResponse({}),
        (cmd) => (cmd === "choco" ? { code: 1, stderr: "raw choco failure detail" } : ""),
      )

      const error = await Effect.runPromise(
        Installation.Service.use((svc) => svc.upgrade("choco", "9.9.9")).pipe(Effect.provide(layer), Effect.flip),
      )
      expect(error.stderr).toBe("not running from an elevated command shell")
      expect(error.message).toBe(error.stderr)
      expect(error.stderr).not.toContain("raw choco failure detail")
    })
  })

  describe("http identity", () => {
    // LLM requests (incl. OpenCode Zen) follow upstream's two-segment User-Agent;
    // the client is carried by the x-opencode-client header, not the User-Agent.
    test("LLM requests use upstream's two-segment User-Agent", () => {
      expect(Installation.LLM_USER_AGENT).toBe(`opencode/${Installation.HTTP_VERSION}`)
      expect(Installation.LLM_USER_AGENT.split("/")).toHaveLength(2)
    })

    // The models.dev catalog fetch keeps upstream's four-segment form.
    test("models.dev catalog fetch keeps upstream's four-segment User-Agent", () => {
      expect(Installation.HTTP_USER_AGENT.split("/")).toHaveLength(4)
      expect(Installation.HTTP_USER_AGENT.startsWith(`opencode/latest/${Installation.HTTP_VERSION}/`)).toBe(true)
    })
  })
})
