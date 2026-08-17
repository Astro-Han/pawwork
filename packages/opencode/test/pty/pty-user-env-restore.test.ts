import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"

// Issue #1528: the desktop app injects XDG_* keys into the embedded server's
// environment to namespace its own config/data/cache/state. A user terminal is
// a user shell — XDG-following CLIs must see the user's values, never the
// app's, and never the restore instruction itself.
//
// The pollution must be in the child Bun process's NATIVE environment: bun-pty
// merges the PTY parent's native environment into spawned children, so keys
// deleted from the spawn env record resurrect from it. This test exists to pin
// exactly that resurrection-suppression path.
describe("pty", () => {
  test("restores user XDG env under native app-namespace pollution", async () => {
    if (process.platform === "win32") return

    const child = spawn(
      process.execPath,
      ["run", "--cwd", import.meta.dir, "./pty-user-env-child.ts"],
      {
        env: {
          // Inherit only what the child needs to run; carry the pollution natively.
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          XDG_CONFIG_HOME: "/tmp/pawwork-user-data/config",
          XDG_DATA_HOME: "/tmp/pawwork-user-data/data",
          PAWWORK_USER_ENV_RESTORE: JSON.stringify({ XDG_CONFIG_HOME: "/Users/tester/.config", XDG_DATA_HOME: null }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    const stdout = await new Promise<string>((resolve, reject) => {
      let text = ""
      child.stdout!.on("data", (chunk) => (text += String(chunk)))
      child.on("error", reject)
      child.on("close", (code) => {
        if (code === 0) resolve(text)
        else reject(new Error(`child exited ${code}: ${text.slice(-400)}`))
      })
    })
    const dumped = stdout.slice(stdout.indexOf("CHILD_ENV_BEGIN"), stdout.indexOf("CHILD_ENV_END"))

    // User-owned value survives verbatim.
    expect(dumped).toContain("XDG_CONFIG_HOME=/Users/tester/.config")
    // App namespace never reaches the user shell (blanked, not just deleted:
    // bun-pty would resurrect a deleted key from the parent's native env).
    expect(dumped).not.toContain("/tmp/pawwork-user-data")
    // The instruction payload itself never leaks into terminals (a blanked
    // marker key remains — bun-pty cannot unset native keys, only blank them).
    expect(dumped).not.toContain("XDG_CONFIG_HOME\":null")
    expect(dumped).not.toContain("PAWWORK_USER_ENV_RESTORE={")
  }, 30000)
})
