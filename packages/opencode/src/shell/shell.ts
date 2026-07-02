import { Flag } from "@opencode-ai/core/flag/flag"
import { lazy } from "@/util/lazy"
import { Filesystem } from "@/util/filesystem"
import { which } from "@/util/which"
import path from "path"
import { spawn, type ChildProcess } from "child_process"
import { setTimeout as sleep } from "node:timers/promises"

const SIGKILL_TIMEOUT_MS = 200

export namespace Shell {
  const BLACKLIST = new Set(["fish", "nu"])
  const LOGIN = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"])
  const POSIX = new Set(["bash", "dash", "ksh", "sh", "zsh"])
  export type Item = {
    path: string
    name: string
    acceptable: boolean
  }

  export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
    const pid = proc.pid
    if (!pid || opts?.exited?.()) return

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
        })
        killer.once("exit", () => resolve())
        killer.once("error", () => resolve())
      })
      return
    }

    try {
      process.kill(-pid, "SIGTERM")
      await sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        process.kill(-pid, "SIGKILL")
      }
    } catch (_e) {
      proc.kill("SIGTERM")
      await sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        proc.kill("SIGKILL")
      }
    }
  }

  function full(file: string) {
    if (process.platform !== "win32") return file
    const shell = Filesystem.windowsPath(file)
    if (path.win32.dirname(shell) !== ".") {
      if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell
      return shell
    }
    return which(shell) || shell
  }

  function pick() {
    const pwsh = which("pwsh.exe")
    if (pwsh) return pwsh
    const powershell = which("powershell.exe")
    if (powershell) return powershell
  }

  function resolved(file: string) {
    const shell = full(file)
    const rooted = process.platform === "win32" ? path.win32.isAbsolute(shell) : path.isAbsolute(shell)
    if (rooted) {
      if (Filesystem.stat(shell)?.isFile()) return shell
      return
    }
    return which(shell) || undefined
  }

  function item(file: string): Item | undefined {
    const shell = resolved(file)
    if (!shell) return
    return {
      path: shell,
      name: which(name(shell)) ? name(shell) : shell,
      acceptable: !BLACKLIST.has(name(shell)),
    }
  }

  function win() {
    return Array.from(
      new Set([which("pwsh"), which("powershell"), gitbash(), process.env.COMSPEC || "cmd.exe"].filter((x): x is string => !!x)),
    )
  }

  async function unix() {
    const text = await Filesystem.readText("/etc/shells").catch(() => "")
    if (!text) return ["/bin/bash", "/bin/zsh", "/bin/sh"]
    const shells = Array.from(
      new Set(
        text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#")),
      ),
    )
    return shells.length ? shells : ["/bin/bash", "/bin/zsh", "/bin/sh"]
  }

  function select(file: string | undefined, opts?: { acceptable?: boolean }) {
    if (file && (!opts?.acceptable || !BLACKLIST.has(name(file)))) return full(file)
    if (process.platform === "win32") {
      const shell = pick()
      if (shell) return shell
    }
    return fallback()
  }

  export function gitbash() {
    if (process.platform !== "win32") return
    if (Flag.OPENCODE_GIT_BASH_PATH) return Flag.OPENCODE_GIT_BASH_PATH
    const git = which("git")
    if (!git) return
    const file = path.join(git, "..", "..", "bin", "bash.exe")
    if (Filesystem.stat(file)?.size) return file
  }

  function fallback() {
    if (process.platform === "win32") {
      const file = gitbash()
      if (file) return file
      return process.env.COMSPEC || "cmd.exe"
    }
    if (process.platform === "darwin") return "/bin/zsh"
    const bash = which("bash")
    if (bash) return bash
    return "/bin/sh"
  }

  export function name(file: string) {
    if (process.platform === "win32") return path.win32.parse(Filesystem.windowsPath(file)).name.toLowerCase()
    return path.basename(file).toLowerCase()
  }

  export function login(file: string) {
    return LOGIN.has(name(file))
  }

  export function posix(file: string) {
    return POSIX.has(name(file))
  }

  export const preferred = lazy(() => select(process.env.SHELL))

  export const acceptable = lazy(() => select(process.env.SHELL, { acceptable: true }))

  export async function list(): Promise<Item[]> {
    const shells = process.platform === "win32" ? win() : await unix()
    return shells.map(item).filter((x): x is Item => x !== undefined)
  }
}
