import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

// Regression for the unconditional `fs.truncate(logpath)` in Log.init (adapted
// from the log-truncation portion of upstream opencode #27384). A single
// OPENCODE_RUN_ID may init the logger more than once (re-entry, subprocesses);
// wiping dev.log on every init dropped earlier lines from the same run. The guard
// truncates dev.log only the first time a given run id is seen.
//
// Hermetic, mirroring test/global.test.ts: run in a subprocess with XDG_* pointed
// at a throwaway dir so Global.Path.log (computed at module load) resolves under
// tmp, never the real ~/.local/share, and the parent process env stays untouched.
function probeTruncationAcrossInits() {
  const root = path.join(os.tmpdir(), "pawwork-log-truncate-test")
  const MARKER = "MARKER_R316"
  const script = `
    process.env.XDG_DATA_HOME = ${JSON.stringify(path.join(root, "share"))}
    process.env.XDG_CACHE_HOME = ${JSON.stringify(path.join(root, "cache"))}
    process.env.XDG_CONFIG_HOME = ${JSON.stringify(path.join(root, "config"))}
    process.env.XDG_STATE_HOME = ${JSON.stringify(path.join(root, "state"))}
    process.env.OPENCODE_RUN_ID = "run-A"
    delete process.env.OPENCODE_LOG_INITIALIZED_RUN_ID
    const fsp = await import("node:fs/promises")
    const { Log } = await import("./src/util/log.ts")

    // run-A, first init: records the run (truncates the empty/fresh file).
    await Log.init({ print: false, dev: true })
    await fsp.writeFile(Log.file(), ${JSON.stringify(MARKER + "\n")})
    // run-A, second init: same run, must NOT truncate.
    await Log.init({ print: false, dev: true })
    const sameRunSurvived = (await fsp.readFile(Log.file(), "utf8")).includes(${JSON.stringify(MARKER)})

    // A different run id must still truncate (the guard is not "never truncate").
    await fsp.writeFile(Log.file(), ${JSON.stringify(MARKER + "\n")})
    process.env.OPENCODE_RUN_ID = "run-B"
    await Log.init({ print: false, dev: true })
    const newRunSurvived = (await fsp.readFile(Log.file(), "utf8")).includes(${JSON.stringify(MARKER)})

    console.log(JSON.stringify({ sameRunSurvived, newRunSurvived }))
  `
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: path.join(import.meta.dir, "..", ".."),
    env: { ...process.env },
  })
  if (result.status !== 0) throw new Error(result.stderr.toString())
  return JSON.parse(result.stdout.toString()) as { sameRunSurvived: boolean; newRunSurvived: boolean }
}

test("dev.log is truncated once per OPENCODE_RUN_ID: re-init within a run preserves earlier lines", () => {
  const { sameRunSurvived, newRunSurvived } = probeTruncationAcrossInits()
  // The fix: second init under the same run id leaves earlier lines intact.
  expect(sameRunSurvived).toBe(true)
  // Guard against an over-broad fix: a new run id still truncates as before.
  expect(newRunSurvived).toBe(false)
})
