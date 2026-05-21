import { describe, expect, test } from "bun:test"
import { spyOn } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import fs from "node:fs"
import nodefs from "node:fs/promises"
import os from "os"
import path from "path"
import { existsSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { Shell } from "../../src/shell/shell"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Plugin } from "../../src/plugin"
import { Global } from "@opencode-ai/core/global"
import { TurnChange } from "../../src/session/turn-change"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { resetDatabase } from "../fixture/db"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    TurnChange.defaultLayer,
  ),
)

function initBash() {
  return runtime.runPromise(BashTool.pipe(Effect.flatMap((info) => info.init())))
}

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

async function createTurn() {
  const session = await SessionNs.create({ title: "bash external artifact" })
  const messageID = MessageID.make(`msg_bash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  await SessionNs.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    parentID: MessageID.make("msg_user"),
    time: { created: Date.now() },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Info)
  return { sessionID: session.id, messageID }
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = Shell.acceptable()
    return [{ label: Shell.name(shell), shell }]
  }

  const list = [bash, Bun.which("pwsh"), Bun.which("powershell"), process.env.COMSPEC || Bun.which("cmd.exe")]
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => ({ label: Shell.name(shell), shell }))

  return list.filter(
    (item, i) => list.findIndex((other) => other.shell.toLowerCase() === item.shell.toLowerCase()) === i,
  )
})()
const PS = new Set(["pwsh", "powershell"])
const ps = shells.filter((item) => PS.has(item.label))

const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

const fill = (mode: "lines" | "bytes", n: number) => {
  const code =
    mode === "lines"
      ? "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>i+1).join(String.fromCharCode(10)))"
      : "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  const text = `${bin} -e ${evalarg(code)} ${n}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const wait = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(25)
  }
  throw new Error("timeout waiting for condition")
}

const withShell = (item: { label: string; shell: string }, fn: () => Promise<void>) => async () => {
  const prev = process.env.SHELL
  process.env.SHELL = item.shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

const each = (
  name: string,
  fn: (item: { label: string; shell: string }) => Promise<void>,
  options?: (item: { label: string; shell: string }) => Parameters<typeof test>[2] | undefined,
) => {
  for (const item of shells) {
    const run = withShell(item, () => fn(item))
    test(`${name} [${item.label}]`, run, options?.(item))
  }
}

const capture = (requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop) throw stop
    }),
})

const mustTruncate = (result: {
  metadata: { truncated?: boolean; exit?: number | null } & Record<string, unknown>
  output: string
}) => {
  if (result.metadata.truncated) return
  throw new Error(
    [`shell: ${process.env.SHELL || ""}`, `exit: ${String(result.metadata.exit)}`, "output:", result.output].join("\n"),
  )
}

describe("tool.bash", () => {
  each(
    "basic",
    async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const bash = await initBash()
          const result = await Effect.runPromise(
            bash.execute(
              {
                command: "echo test",
                description: "Echo test message",
              },
              ctx,
            ),
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.metadata.output).toContain("test")
        },
      })
    },
    // pwsh cold start on Windows hosted runners can exceed Bun's default 30s.
    (item) => (item.label === "pwsh" ? { timeout: 60_000 } : undefined),
  )

  each("does not expose internal server auth env to user commands", async () => {
    const previousUsername = process.env.OPENCODE_SERVER_USERNAME
    const previousLowerUsername = process.env.opencode_server_username
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD
    const previousLowerPassword = process.env.opencode_server_password
    const previousCustom = process.env.PAWWORK_E2E_CUSTOM_ENV
    process.env.OPENCODE_SERVER_USERNAME = "PawWork"
    process.env.opencode_server_username = "lower-user"
    process.env.OPENCODE_SERVER_PASSWORD = "secret"
    process.env.opencode_server_password = "lower-secret"
    process.env.PAWWORK_E2E_CUSTOM_ENV = "kept"
    // Write the script to a tmp file rather than passing it inline as `bun -e`.
    // PowerShell 5.1 and cmd reparse embedded double quotes inside an inline
    // arg before forwarding it to the native exe, which breaks the JS source
    // and made the user command exit 1 before any env assertion ran. Loading
    // from a file avoids every shell-specific quoting trap.
    await using tmp = await tmpdir()
    const scriptPath = path.join(tmp.path, "env-probe.mjs")
    fs.writeFileSync(
      scriptPath,
      [
        'console.log("username=" + (process.env.OPENCODE_SERVER_USERNAME ?? "unset"))',
        'console.log("usernameLower=" + (process.env.opencode_server_username ?? "unset"))',
        'console.log("password=" + (process.env.OPENCODE_SERVER_PASSWORD ?? "unset"))',
        'console.log("passwordLower=" + (process.env.opencode_server_password ?? "unset"))',
        'console.log("custom=" + (process.env.PAWWORK_E2E_CUSTOM_ENV ?? "unset"))',
      ].join("\n"),
    )
    const scriptArg = quote(scriptPath.replaceAll("\\", "/"))
    const command = `${PS.has(sh()) ? "& " : ""}${bin} ${scriptArg}`

    try {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const bash = await initBash()
          const result = await Effect.runPromise(
            bash.execute(
              {
                command,
                description: "Print selected environment variables",
              },
              ctx,
            ),
          )

          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("username=unset")
          expect(result.output).toContain("usernameLower=unset")
          expect(result.output).toContain("password=unset")
          expect(result.output).toContain("passwordLower=unset")
          expect(result.output).toContain("custom=kept")
          expect(result.output).not.toContain("secret")
          expect(result.output).not.toContain("lower-user")
          expect(result.output).not.toContain("lower-secret")
        },
      })
    } finally {
      if (previousUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
      else process.env.OPENCODE_SERVER_USERNAME = previousUsername
      if (previousLowerUsername === undefined) delete process.env.opencode_server_username
      else process.env.opencode_server_username = previousLowerUsername
      if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
      else process.env.OPENCODE_SERVER_PASSWORD = previousPassword
      if (previousLowerPassword === undefined) delete process.env.opencode_server_password
      else process.env.opencode_server_password = previousLowerPassword
      if (previousCustom === undefined) delete process.env.PAWWORK_E2E_CUSTOM_ENV
      else process.env.PAWWORK_E2E_CUSTOM_ENV = previousCustom
    }
  })
})

describe("tool.bash expected_outputs", () => {
  test("records a declared binary artifact in turn-change", async () => {
    await resetDatabase()
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const turn = await createTurn()
        const target = path.join(tmp.path, "report.docx")
        const script = path.join(tmp.path, "write-docx.cjs")
        await fs.promises.writeFile(
          script,
          "require('node:fs').writeFileSync(process.argv[2], Buffer.from([80,75,3,4,0,1,2,3]))\n",
          "utf-8",
        )
        const command = `${PS.has(sh()) ? "& " : ""}${bin} ${quote(script.replaceAll("\\", "/"))} ${quote(target.replaceAll("\\", "/"))}`
        const result = await Effect.runPromise(
          bash.execute(
            {
              command,
              expected_outputs: [target],
              description: "Create binary report",
            },
            { ...ctx, ...turn },
          ),
        )

        expect(result.metadata.exit).toBe(0)
        expect(
          (
            result.metadata as {
              artifacts?: Array<{ path: string; exists: boolean; changed: boolean; binary?: boolean }>
            }
          ).artifacts,
        ).toEqual([{ path: target, exists: true, changed: true, binary: true }])

        const display = TurnChange.finalize(turn)
        expect(display?.files).toEqual([
          {
            path: "report.docx",
            status: "added",
            binary: true,
            restoreAvailable: false,
            expandable: false,
          },
        ])
      },
    })
  })

  test("records a declared text artifact using the text hash path", async () => {
    await resetDatabase()
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const turn = await createTurn()
        const target = path.join(tmp.path, "notes.txt")
        const script = path.join(tmp.path, "write-text.cjs")
        await fs.promises.writeFile(script, "require('node:fs').writeFileSync(process.argv[2], 'hello\\n')\n", "utf-8")
        const command = `${PS.has(sh()) ? "& " : ""}${bin} ${quote(script.replaceAll("\\", "/"))} ${quote(target.replaceAll("\\", "/"))}`
        const result = await Effect.runPromise(
          bash.execute(
            {
              command,
              expected_outputs: [target],
              description: "Create text report",
            },
            { ...ctx, ...turn },
          ),
        )

        expect(result.metadata.exit).toBe(0)
        expect(
          (
            result.metadata as {
              artifacts?: Array<{ path: string; exists: boolean; changed: boolean; binary?: boolean }>
            }
          ).artifacts,
        ).toEqual([{ path: target, exists: true, changed: true }])

        expect(TurnChange.finalize(turn)?.files).toMatchObject([
          {
            path: "notes.txt",
            status: "added",
            expandable: true,
            additions: 1,
            deletions: 0,
          },
        ])
      },
    })
  })

  test("records a declared BOM text artifact using the text hash path", async () => {
    await resetDatabase()
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const turn = await createTurn()
        const target = path.join(tmp.path, "notes-bom.txt")
        const script = path.join(tmp.path, "write-bom-text.cjs")
        await fs.promises.writeFile(
          script,
          "require('node:fs').writeFileSync(process.argv[2], '\\uFEFFhello\\n')\n",
          "utf-8",
        )
        const command = `${PS.has(sh()) ? "& " : ""}${bin} ${quote(script.replaceAll("\\", "/"))} ${quote(target.replaceAll("\\", "/"))}`
        const result = await Effect.runPromise(
          bash.execute(
            {
              command,
              expected_outputs: [target],
              description: "Create BOM text report",
            },
            { ...ctx, ...turn },
          ),
        )

        expect(result.metadata.exit).toBe(0)
        expect(
          (result.metadata as { artifacts?: Array<{ path: string; exists: boolean; changed: boolean }> }).artifacts,
        ).toEqual([{ path: target, exists: true, changed: true }])

        expect(TurnChange.finalize(turn)?.files).toMatchObject([
          {
            path: "notes-bom.txt",
            status: "added",
            expandable: true,
            additions: 1,
            deletions: 0,
          },
        ])
      },
    })
  })

  test("records declared outputs even when command exits non-zero after writing", async () => {
    await resetDatabase()
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const turn = await createTurn()
        const target = path.join(tmp.path, "partial.docx")
        const script = path.join(tmp.path, "write-then-fail.cjs")
        await fs.promises.writeFile(
          script,
          "require('node:fs').writeFileSync(process.argv[2], Buffer.from([80,75,3,4,0,9]))\nprocess.exit(1)\n",
          "utf-8",
        )
        const command = `${PS.has(sh()) ? "& " : ""}${bin} ${quote(script.replaceAll("\\", "/"))} ${quote(target.replaceAll("\\", "/"))}`
        const result = await Effect.runPromise(
          bash.execute(
            {
              command,
              expected_outputs: [target],
              description: "Write then fail",
            },
            { ...ctx, ...turn },
          ),
        )

        expect(result.metadata.exit).toBe(1)
        const display = TurnChange.finalize(turn)
        expect(display?.files[0]).toMatchObject({
          path: "partial.docx",
          status: "added",
          binary: true,
          expandable: false,
        })
      },
    })
  })

  test("resolves relative expected_outputs against workdir", async () => {
    await resetDatabase()
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.mkdir(path.join(dir, "nested"), { recursive: true })
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const turn = await createTurn()
        const nested = path.join(tmp.path, "nested")
        const target = path.join(nested, "report.txt")
        const script = path.join(tmp.path, "write-relative.cjs")
        await fs.promises.writeFile(
          script,
          "require('node:fs').writeFileSync(process.argv[2], 'relative\\n')\n",
          "utf-8",
        )
        const command = `${PS.has(sh()) ? "& " : ""}${bin} ${quote(script.replaceAll("\\", "/"))} report.txt`
        const result = await Effect.runPromise(
          bash.execute(
            {
              command,
              workdir: "nested",
              expected_outputs: ["report.txt"],
              description: "Create workdir-relative output",
            },
            { ...ctx, ...turn },
          ),
        )

        expect(result.metadata.exit).toBe(0)
        expect(
          (result.metadata as { artifacts?: Array<{ path: string; exists: boolean; changed: boolean }> }).artifacts,
        ).toEqual([{ path: target, exists: true, changed: true }])
        expect(
          TurnChange.finalize(turn)?.files?.some(
            (file) => file.path === "nested/report.txt" && file.status === "added",
          ),
        ).toBe(true)
      },
    })
  })

  test("does not record unchanged declared paths", async () => {
    await resetDatabase()
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.writeFile(path.join(dir, "stable.txt"), "stable\n", "utf-8")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const turn = await createTurn()
        const target = path.join(tmp.path, "stable.txt")
        await Effect.runPromise(
          bash.execute(
            {
              command: "echo noop",
              expected_outputs: [target],
              description: "Leave file unchanged",
            },
            { ...ctx, ...turn },
          ),
        )

        expect(TurnChange.finalize(turn)).toBeUndefined()
      },
    })
  })

  test("records uncaptured marker for write-like command when expected_outputs is omitted", async () => {
    await resetDatabase()
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const turn = await createTurn()
        const target = path.join(tmp.path, "undeclared.txt")
        const command = PS.has(sh())
          ? `Set-Content -Path ${quote(target.replaceAll("\\", "/"))} -Value hello`
          : `printf 'hello\\n' > ${quote(target.replaceAll("\\", "/"))}`
        const result = await Effect.runPromise(
          bash.execute(
            {
              command,
              description: "Write without declaration",
            },
            { ...ctx, ...turn },
          ),
        )

        expect(result.metadata.exit).toBe(0)
        expect((result.metadata as { artifacts?: unknown[] }).artifacts).toBeUndefined()
        expect(TurnChange.finalize(turn)).toBeUndefined()
        expect(
          TurnChange.aggregateTurnUnion({ sessionID: turn.sessionID, userMessageID: MessageID.make("msg_user") }),
        ).toMatchObject({
          kind: "uncaptured",
          count: 1,
        })
      },
    })
  })

  test("does not record uncaptured marker for read-only command without expected_outputs", async () => {
    await resetDatabase()
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const turn = await createTurn()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: "echo hi",
              description: "Echo read only text",
            },
            { ...ctx, ...turn },
          ),
        )

        expect(result.metadata.exit).toBe(0)
        expect(
          TurnChange.aggregateTurnUnion({ sessionID: turn.sessionID, userMessageID: MessageID.make("msg_user") }),
        ).toMatchObject({
          kind: "empty",
        })
      },
    })
  })

  test("does not record false positives when the before state is indeterminate", async () => {
    await resetDatabase()
    await using tmp = await tmpdir({
      init: async (dir) => {
        const target = path.join(dir, "restricted.txt")
        await fs.promises.writeFile(target, "secret\n", "utf-8")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const turn = await createTurn()
        const target = path.join(tmp.path, "restricted.txt")
        const originalReadFile = nodefs.readFile
        const readSpy = spyOn(nodefs as any, "readFile").mockImplementationOnce(async (...args: any[]) => {
          const filepath = typeof args[0] === "string" ? args[0] : String(args[0])
          if (filepath === target) {
            const err = Object.assign(new Error("denied"), { code: "EACCES" })
            throw err
          }
          return await (originalReadFile as any)(...args)
        })
        try {
          const result = await Effect.runPromise(
            bash.execute(
              {
                command: `rm ${quote(target.replaceAll("\\", "/"))}`,
                expected_outputs: [target],
                description: "Delete unreadable file",
              },
              { ...ctx, ...turn },
            ),
          )

          expect(result.metadata.exit).toBe(0)
          expect(
            (
              result.metadata as {
                artifacts?: Array<{
                  path: string
                  exists: boolean
                  changed: boolean
                  comparable?: boolean
                  errorCode?: string
                }>
              }
            ).artifacts,
          ).toEqual([{ path: target, exists: false, changed: false, comparable: false, errorCode: "EACCES" }])
          expect(TurnChange.finalize(turn)).toBeUndefined()
        } finally {
          readSpy.mockRestore()
        }
      },
    })
  })
})

describe("tool.bash permissions", () => {
  each("asks for bash permission with correct pattern", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(
          bash.execute(
            {
              command: "echo hello",
              description: "Echo hello",
            },
            capture(requests),
          ),
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("bash")
        expect(requests[0].patterns).toContain("echo hello")
      },
    })
  })

  each("asks for bash permission with multiple commands", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(
          bash.execute(
            {
              command: "echo foo && echo bar",
              description: "Echo twice",
            },
            capture(requests),
          ),
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("bash")
        expect(requests[0].patterns).toContain("echo foo")
        expect(requests[0].patterns).toContain("echo bar")
      },
    })
  })

  for (const item of ps) {
    test(
      `parses PowerShell conditionals for permission prompts [${item.label}]`,
      withShell(item, async () => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const bash = await initBash()
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            await Effect.runPromise(
              bash.execute(
                {
                  command: "Write-Host foo; if ($?) { Write-Host bar }",
                  description: "Check PowerShell conditional",
                },
                capture(requests),
              ),
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.patterns).toContain("Write-Host foo")
            expect(bashReq!.patterns).toContain("Write-Host bar")
            expect(bashReq!.always).toContain("Write-Host *")
          },
        })
      }),
    )
  }

  each("asks for external_directory permission for wildcard external paths", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initBash()
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const file = process.platform === "win32" ? `${process.env.WINDIR!.replaceAll("\\", "/")}/*` : "/etc/*"
        const want =
          process.platform === "win32"
            ? glob(path.join(process.env.WINDIR!, "*"))
            : path.join(await fs.promises.realpath("/etc"), "*")
        await expect(
          Effect.runPromise(
            bash.execute(
              {
                command: `cat ${file}`,
                description: "Read wildcard path",
              },
              capture(requests, err),
            ),
          ),
        ).rejects.toThrow(err.message)
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(want)
      },
    })
  })

  if (process.platform === "win32") {
    if (bash) {
      test(
        "asks for nested bash command permissions [bash]",
        withShell({ label: "bash", shell: bash }, async () => {
          await using outerTmp = await tmpdir({
            init: async (dir) => {
              await Bun.write(path.join(dir, "outside.txt"), "x")
            },
          })
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const file = path.join(outerTmp.path, "outside.txt").replaceAll("\\", "/")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await Effect.runPromise(
                bash.execute(
                  {
                    command: `echo $(cat "${file}")`,
                    description: "Read nested bash file",
                  },
                  capture(requests),
                ),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(outerTmp.path, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`cat "${file}"`)
            },
          })
        }),
      )
    }
  }

  if (process.platform === "win32") {
    for (const item of ps) {
      test(
        `asks for external_directory permission for PowerShell paths after switches [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: `Copy-Item -PassThru "${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini" ./out`,
                      description: "Copy Windows ini",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for real external_directory when PowerShell reads through tmp junction [${item.label}]`,
        withShell(item, async () => {
          await using outside = await tmpdir({
            init: async (dir) => {
              await Bun.write(path.join(dir, "secret.txt"), "secret")
            },
          })
          await using tmp = await tmpdir({ git: true })

          const link = path.join(Global.Path.tmp, `bash-win-existing-${process.pid}-${Date.now()}`)
          await fs.promises.rm(link, { recursive: true, force: true })
          await fs.promises.symlink(outside.path, link, "junction")
          try {
            await Instance.provide({
              directory: tmp.path,
              fn: async () => {
                const bash = await initBash()
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                await expect(
                  Effect.runPromise(
                    bash.execute(
                      {
                        command: `Get-Content "${path.join(link, "secret.txt")}"`,
                        description: "Read tmp junction file",
                      },
                      capture(requests, err),
                    ),
                  ),
                ).rejects.toThrow(err.message)
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                const expected = glob(path.join(await fs.promises.realpath(outside.path), "*"))
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(expected)
              },
            })
          } finally {
            await fs.promises.rm(link, { recursive: true, force: true })
          }
        }),
      )

      test(
        `asks for real external_directory when PowerShell creates through tmp junction [${item.label}]`,
        withShell(item, async () => {
          await using outside = await tmpdir()
          await using tmp = await tmpdir({ git: true })

          const link = path.join(Global.Path.tmp, `bash-win-new-${process.pid}-${Date.now()}`)
          await fs.promises.rm(link, { recursive: true, force: true })
          await fs.promises.symlink(outside.path, link, "junction")
          try {
            await Instance.provide({
              directory: tmp.path,
              fn: async () => {
                const bash = await initBash()
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                await expect(
                  Effect.runPromise(
                    bash.execute(
                      {
                        command: `New-Item -ItemType File "${path.join(link, "new.txt")}"`,
                        description: "Create tmp junction file",
                      },
                      capture(requests, err),
                    ),
                  ),
                ).rejects.toThrow(err.message)
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                const expected = glob(path.join(await fs.promises.realpath(outside.path), "*"))
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(expected)
              },
            })
          } finally {
            await fs.promises.rm(link, { recursive: true, force: true })
          }
        }),
      )

      test(
        `asks for real external_directory when PowerShell path traverses after tmp junction [${item.label}]`,
        withShell(item, async () => {
          await using outside = await tmpdir()
          await using tmp = await tmpdir({ git: true })

          const link = path.join(Global.Path.tmp, `bash-win-dotdot-${process.pid}-${Date.now()}`)
          await fs.promises.rm(link, { recursive: true, force: true })
          await fs.promises.symlink(outside.path, link, "junction")
          try {
            await Instance.provide({
              directory: tmp.path,
              fn: async () => {
                const bash = await initBash()
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                const target = `${link}\\..\\new.txt`
                await expect(
                  Effect.runPromise(
                    bash.execute(
                      {
                        command: `Set-Content "${target}" "x"`,
                        description: "Write parent junction file",
                      },
                      capture(requests, err),
                    ),
                  ),
                ).rejects.toThrow(err.message)
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                const expected = glob(path.join(path.dirname(await fs.promises.realpath(outside.path)), "*"))
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(expected)
              },
            })
          } finally {
            await fs.promises.rm(link, { recursive: true, force: true })
          }
        }),
      )

      test(
        `asks for real external_directory when PowerShell workdir traverses after junction [${item.label}]`,
        withShell(item, async () => {
          await using outside = await tmpdir()
          await using tmp = await tmpdir({ git: true })

          const link = path.join(tmp.path, "link")
          await fs.promises.symlink(outside.path, link, "junction")

          await Instance.provide({
            directory: tmp.path,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const workdir = `${link}\\..`
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: "Write-Output ok",
                      workdir,
                      description: "Echo from junction parent",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const expected = glob(path.join(path.dirname(await fs.promises.realpath(outside.path)), "*"))
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(expected)
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for nested PowerShell command permissions [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const file = `${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`
              await Effect.runPromise(
                bash.execute(
                  {
                    command: `Write-Output $(Get-Content ${file})`,
                    description: "Read nested PowerShell file",
                  },
                  capture(requests),
                ),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`Get-Content ${file}`)
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for drive-relative PowerShell paths [${item.label}]`,
        withShell(item, async () => {
          await using tmp = await tmpdir()
          await Instance.provide({
            directory: tmp.path,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: 'Get-Content "C:../outside.txt"',
                      description: "Read drive-relative file",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp.path), "*")))
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for $HOME PowerShell paths [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: 'Get-Content "$HOME/.ssh/config"',
                      description: "Read home config",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(os.homedir(), ".ssh", "*")))
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for $PWD PowerShell paths [${item.label}]`,
        withShell(item, async () => {
          await using tmp = await tmpdir()
          await Instance.provide({
            directory: tmp.path,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: 'Get-Content "$PWD/../outside.txt"',
                      description: "Read pwd-relative file",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp.path), "*")))
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for $PSHOME PowerShell paths [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: 'Get-Content "$PSHOME/outside.txt"',
                      description: "Read pshome file",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(item.shell), "*")))
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for missing PowerShell env paths [${item.label}]`,
        withShell(item, async () => {
          const key = "OPENCODE_TEST_MISSING"
          const prev = process.env[key]
          delete process.env[key]
          try {
            await Instance.provide({
              directory: projectRoot,
              fn: async () => {
                const bash = await initBash()
                const err = new Error("stop after permission")
                const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
                const root = path.parse(process.env.WINDIR!).root.replace(/[\\/]+$/, "")
                await expect(
                  Effect.runPromise(
                    bash.execute(
                      {
                        command: `Get-Content -Path "${root}$env:${key}\\Windows\\win.ini"`,
                        description: "Read Windows ini with missing env",
                      },
                      capture(requests, err),
                    ),
                  ),
                ).rejects.toThrow(err.message)
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              },
            })
          } finally {
            if (prev === undefined) delete process.env[key]
            else process.env[key] = prev
          }
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for PowerShell env paths [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await Effect.runPromise(
                bash.execute(
                  {
                    command: "Get-Content $env:WINDIR/win.ini",
                    description: "Read Windows ini from env",
                  },
                  capture(requests),
                ),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for PowerShell FileSystem paths [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: `Get-Content -Path FileSystem::${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
                      description: "Read Windows ini from FileSystem provider",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for braced PowerShell env paths [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: "Get-Content ${env:WINDIR}/win.ini",
                      description: "Read Windows ini from braced env",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `treats Set-Location like cd for permissions [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await Effect.runPromise(
                bash.execute(
                  {
                    command: "Set-Location C:/Windows",
                    description: "Change location",
                  },
                  capture(requests),
                ),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
              expect(bashReq).toBeUndefined()
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `does not add nested PowerShell expressions to permission prompts [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              await Effect.runPromise(
                bash.execute(
                  {
                    command: "Write-Output ('a' * 3)",
                    description: "Write repeated text",
                  },
                  capture(requests),
                ),
              )
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).not.toContain("a * 3")
              expect(bashReq!.always).not.toContain("a *")
            },
          })
        }),
      )
    }
  }

  each("asks for external_directory permission when cd to parent", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await expect(
          Effect.runPromise(
            bash.execute(
              {
                command: "cd ../",
                description: "Change to parent directory",
              },
              capture(requests, err),
            ),
          ),
        ).rejects.toThrow(err.message)
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
      },
    })
  })

  each("asks for external_directory permission when workdir is outside project", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await expect(
          Effect.runPromise(
            bash.execute(
              {
                command: "echo ok",
                workdir: os.tmpdir(),
                description: "Echo from temp dir",
              },
              capture(requests, err),
            ),
          ),
        ).rejects.toThrow(err.message)
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(glob(path.join(await fs.promises.realpath(os.tmpdir()), "*")))
      },
    })
  })

  if (process.platform === "win32") {
    test("normalizes external_directory workdir variants on Windows", async () => {
      const err = new Error("stop after permission")
      await using outerTmp = await tmpdir()
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const bash = await initBash()
          const want = Filesystem.normalizePathPattern(path.join(outerTmp.path, "*"))

          for (const dir of forms(outerTmp.path)) {
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            await expect(
              Effect.runPromise(
                bash.execute(
                  {
                    command: "echo ok",
                    workdir: dir,
                    description: "Echo from external dir",
                  },
                  capture(requests, err),
                ),
              ),
            ).rejects.toThrow(err.message)

            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect({ dir, patterns: extDirReq?.patterns, always: extDirReq?.always }).toEqual({
              dir,
              patterns: [want],
              always: [want],
            })
          }
        },
      })
    })

    if (bash) {
      test(
        "uses Git Bash /tmp semantics for external workdir",
        withShell({ label: "bash", shell: bash }, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: "echo ok",
                      workdir: "/tmp",
                      description: "Echo from Git Bash tmp",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            },
          })
        }),
      )

      test(
        "uses Git Bash /tmp semantics for external file paths",
        withShell({ label: "bash", shell: bash }, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await initBash()
              const err = new Error("stop after permission")
              const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              await expect(
                Effect.runPromise(
                  bash.execute(
                    {
                      command: "cat /tmp/opencode-does-not-exist",
                      description: "Read Git Bash tmp file",
                    },
                    capture(requests, err),
                  ),
                ),
              ).rejects.toThrow(err.message)
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            },
          })
        }),
      )
    }
  }

  each("asks for external_directory permission when file arg is outside project", async () => {
    await using outerTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "outside.txt"), "x")
      },
    })
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const filepath = path.join(outerTmp.path, "outside.txt")
        await expect(
          Effect.runPromise(
            bash.execute(
              {
                command: `cat ${filepath}`,
                description: "Read external file",
              },
              capture(requests, err),
            ),
          ),
        ).rejects.toThrow(err.message)
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        const expected = glob(path.join(outerTmp.path, "*"))
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(expected)
        expect(extDirReq!.always).toContain(expected)
      },
    })
  })

  if (process.platform !== "win32") {
    test("asks for real external_directory when bash reads through tmp symlink", async () => {
      await using outside = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "secret.txt"), "secret")
        },
      })
      await using tmp = await tmpdir({ git: true })

      const link = path.join(Global.Path.tmp, `bash-existing-${process.pid}-${Date.now()}`)
      await fs.promises.rm(link, { recursive: true, force: true })
      await fs.promises.symlink(outside.path, link, "dir")
      try {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const bash = await initBash()
            const err = new Error("stop after permission")
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            await expect(
              Effect.runPromise(
                bash.execute(
                  {
                    command: `cat ${link}/secret.txt`,
                    description: "Read tmp symlink file",
                  },
                  capture(requests, err),
                ),
              ),
            ).rejects.toThrow(err.message)
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            const expected = glob(path.join(await fs.promises.realpath(outside.path), "*"))
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(expected)
          },
        })
      } finally {
        await fs.promises.rm(link, { recursive: true, force: true })
      }
    })

    test("asks for real external_directory when bash creates through tmp symlink", async () => {
      await using outside = await tmpdir()
      await using tmp = await tmpdir({ git: true })

      const link = path.join(Global.Path.tmp, `bash-new-${process.pid}-${Date.now()}`)
      await fs.promises.rm(link, { recursive: true, force: true })
      await fs.promises.symlink(outside.path, link, "dir")
      try {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const bash = await initBash()
            const err = new Error("stop after permission")
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            await expect(
              Effect.runPromise(
                bash.execute(
                  {
                    command: `touch ${link}/new.txt`,
                    description: "Create tmp symlink file",
                  },
                  capture(requests, err),
                ),
              ),
            ).rejects.toThrow(err.message)
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            const expected = glob(path.join(await fs.promises.realpath(outside.path), "*"))
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(expected)
          },
        })
      } finally {
        await fs.promises.rm(link, { recursive: true, force: true })
      }
    })

    test("asks for real external_directory when bash path traverses after tmp symlink", async () => {
      await using outside = await tmpdir()
      await using tmp = await tmpdir({ git: true })

      const link = path.join(Global.Path.tmp, `bash-dotdot-${process.pid}-${Date.now()}`)
      await fs.promises.rm(link, { recursive: true, force: true })
      await fs.promises.symlink(outside.path, link, "dir")
      try {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const bash = await initBash()
            const err = new Error("stop after permission")
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            const target = `${link}/../new.txt`
            await expect(
              Effect.runPromise(
                bash.execute(
                  {
                    command: `touch ${target}`,
                    description: "Create parent symlink file",
                  },
                  capture(requests, err),
                ),
              ),
            ).rejects.toThrow(err.message)
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            const expected = glob(path.join(path.dirname(await fs.promises.realpath(outside.path)), "*"))
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(expected)
          },
        })
      } finally {
        await fs.promises.rm(link, { recursive: true, force: true })
      }
    })

    test("asks for real external_directory when bash workdir traverses after symlink", async () => {
      await using outside = await tmpdir()
      await using tmp = await tmpdir({ git: true })

      const link = path.join(tmp.path, "link")
      await fs.promises.symlink(outside.path, link, "dir")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const bash = await initBash()
          const err = new Error("stop after permission")
          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const workdir = `${link}/..`
          await expect(
            Effect.runPromise(
              bash.execute(
                {
                  command: "echo ok",
                  workdir,
                  description: "Echo from symlink parent",
                },
                capture(requests, err),
              ),
            ),
          ).rejects.toThrow(err.message)
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(path.dirname(await fs.promises.realpath(outside.path)), "*"))
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(expected)
        },
      })
    })
  }

  each("does not ask for external_directory permission when rm inside project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "tmpfile"), "x")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(
          bash.execute(
            {
              command: `rm -rf ${path.join(tmp.path, "nested")}`,
              description: "Remove nested dir",
            },
            capture(requests),
          ),
        )
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeUndefined()
      },
    })
  })

  each("includes always patterns for auto-approval", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(
          bash.execute(
            {
              command: "git log --oneline -5",
              description: "Git log",
            },
            capture(requests),
          ),
        )
        expect(requests.length).toBe(1)
        expect(requests[0].always.length).toBeGreaterThan(0)
        expect(requests[0].always.some((item) => item.endsWith("*"))).toBe(true)
      },
    })
  })

  each("does not ask for bash permission when command is cd only", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(
          bash.execute(
            {
              command: "cd .",
              description: "Stay in current directory",
            },
            capture(requests),
          ),
        )
        const bashReq = requests.find((r) => r.permission === "bash")
        expect(bashReq).toBeUndefined()
      },
    })
  })

  each("matches redirects in permission pattern", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const err = new Error("stop after permission")
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await expect(
          Effect.runPromise(
            bash.execute(
              { command: "echo test > output.txt", description: "Redirect test output" },
              capture(requests, err),
            ),
          ),
        ).rejects.toThrow(err.message)
        const bashReq = requests.find((r) => r.permission === "bash")
        expect(bashReq).toBeDefined()
        expect(bashReq!.patterns).toContain("echo test > output.txt")
      },
    })
  })

  each("always pattern has space before wildcard to not include different commands", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await initBash()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(bash.execute({ command: "ls -la", description: "List" }, capture(requests)))
        const bashReq = requests.find((r) => r.permission === "bash")
        expect(bashReq).toBeDefined()
        expect(bashReq!.always[0]).toBe("ls *")
      },
    })
  })
})

describe("tool.bash abort", () => {
  test("preserves output when aborted", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initBash()
        const controller = new AbortController()
        const collected: string[] = []
        const res = await Effect.runPromise(
          bash.execute(
            {
              command: `echo before && sleep 30`,
              description: "Long running command",
            },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output && output.includes("before") && !controller.signal.aborted) {
                    collected.push(output)
                    controller.abort()
                  }
                }),
            },
          ),
        )
        expect(res.output).toContain("before")
        expect(res.output).toContain("User aborted the command")
        expect(collected.length).toBeGreaterThan(0)
      },
    })
  }, 15_000)

  test("terminates child processes that ignore TERM on abort", async () => {
    if (process.platform === "win32") return

    await using dir = await tmpdir()

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const bash = await initBash()
        const controller = new AbortController()
        const pidFile = path.join(dir.path, "bash-child.pid")
        const child = `trap '' HUP TERM; echo $$ > ${JSON.stringify(pidFile)}; while :; do sleep 1; done`
        const res = await Effect.runPromise(
          bash.execute(
            {
              command: `/bin/sh -c ${JSON.stringify(child)} & echo before; wait`,
              description: "Abort child tree",
            },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output?.includes("before") && !controller.signal.aborted) controller.abort()
                }),
            },
          ),
        )

        expect(res.output).toContain("before")
        expect(res.output).toContain("User aborted the command")
        await wait(() => existsSync(pidFile))
        const pid = Number((await Bun.file(pidFile).text()).trim())
        await wait(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        })
      },
    })
  }, 15_000)

  test("terminates command on timeout", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initBash()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: `echo started && sleep 60`,
              description: "Timeout test",
              timeout: 500,
            },
            ctx,
          ),
        )
        expect(result.output).toContain("started")
        expect(result.output).toContain("bash tool terminated command after exceeding timeout")
        expect(result.output).toContain("retry with a larger timeout value in milliseconds")
      },
    })
  }, 15_000)

  test.skipIf(process.platform === "win32")("captures stderr in output", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initBash()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: `echo stdout_msg && echo stderr_msg >&2`,
              description: "Stderr test",
            },
            ctx,
          ),
        )
        expect(result.output).toContain("stdout_msg")
        expect(result.output).toContain("stderr_msg")
        expect(result.metadata.exit).toBe(0)
      },
    })
  })

  test("returns non-zero exit code", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initBash()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: `exit 42`,
              description: "Non-zero exit",
            },
            ctx,
          ),
        )
        expect(result.metadata.exit).toBe(42)
      },
    })
  })

  test("streams metadata updates progressively", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initBash()
        const updates: string[] = []
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: `echo first && sleep 0.1 && echo second`,
              description: "Streaming test",
            },
            {
              ...ctx,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output) updates.push(output)
                }),
            },
          ),
        )
        expect(result.output).toContain("first")
        expect(result.output).toContain("second")
        expect(updates.length).toBeGreaterThan(1)
      },
    })
  })
})

describe("tool.bash truncation", () => {
  test("truncates output exceeding line limit", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initBash()
        const lineCount = Truncate.MAX_LINES + 500
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: fill("lines", lineCount),
              description: "Generate lines exceeding limit",
            },
            ctx,
          ),
        )
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      },
    })
  })

  test("truncates output exceeding byte limit", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initBash()
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: fill("bytes", byteCount),
              description: "Generate bytes exceeding limit",
            },
            ctx,
          ),
        )
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      },
    })
  })

  test("does not truncate small output", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initBash()
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: "echo hello",
              description: "Echo hello",
            },
            ctx,
          ),
        )
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect(result.output).toContain("hello")
      },
    })
  })

  test("full output is saved to file when truncated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await initBash()
        const lineCount = Truncate.MAX_LINES + 100
        const result = await Effect.runPromise(
          bash.execute(
            {
              command: fill("lines", lineCount),
              description: "Generate lines for file check",
            },
            ctx,
          ),
        )
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = await Filesystem.readText(filepath!)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      },
    })
  })
})
