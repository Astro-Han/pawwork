// Child helper for pty-user-env-restore.test.ts. Runs in a Bun process whose
// NATIVE environment carries the app-namespace pollution — only that way does
// bun-pty's parent-env merge (the behavior under test) resurrect deleted keys.
// Creates a PTY, dumps the child's environment, prints it between markers.
import { mkdirSync } from "node:fs"
import path from "node:path"

const pkgRoot = path.resolve(import.meta.dir, "../..")
const { Pty } = await import(pkgRoot + "/src/pty/index.ts")
const { AppRuntime } = await import(pkgRoot + "/src/effect/app-runtime.ts")
const { Instance } = await import(pkgRoot + "/src/project/instance.ts")

const dir = path.join(pkgRoot, "../../test-tmp/pty-user-env-child")
mkdirSync(dir, { recursive: true })

const run = (fn: any) => AppRuntime.runPromise(Pty.Service.use(fn))

await Instance.provide({
  directory: dir,
  fn: async () => {
    const info = await run((svc: any) =>
      svc.create({
        command: "/bin/sh",
        args: ["-c", "sleep 0.5; /usr/bin/env; sleep 0.5"],
        title: "env probe",
      }),
    )
    let out = ""
    const ws = {
      readyState: 1,
      send: (data: unknown) => {
        out += typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8")
      },
      close: () => undefined,
    }
    await run((svc: any) => svc.connect(info.id, ws as never))
    await new Promise((resolve) => setTimeout(resolve, 2500))
    await run((svc: any) => svc.remove(info.id))
    process.stdout.write(`CHILD_ENV_BEGIN\n${out}\nCHILD_ENV_END\n`)
    process.exit(0)
  },
})
