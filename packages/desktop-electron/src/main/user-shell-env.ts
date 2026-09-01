import { execFile as nodeExecFile } from "node:child_process"

export type ExecFileStub = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
) => unknown

type ApplyUserShellPathOptions = {
  execFile?: ExecFileStub
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  shell?: string
  timeoutMs?: number
}

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void

// One probe per environment per session: the login-shell PATH does not change
// while the process runs, and re-spawning an interactive shell per call would
// multiply the worst case this module adds to startup.
const resolved = new WeakMap<NodeJS.ProcessEnv, Promise<boolean>>()

// GUI launches hand the app launchd's minimal PATH, so user-installed CLIs
// (`/opt/homebrew/bin`, …) are invisible to every child we spawn. Resolving the
// login shell's own PATH once and merging it into `process.env` fixes that for
// all children at once; `prepareDshToolsEnvironment` still prepends our pinned
// tool dirs on top.
export function applyUserShellPath(options: ApplyUserShellPathOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env
  if ((options.platform ?? process.platform) !== "darwin") return Promise.resolve(false)
  const cached = resolved.get(env)
  if (cached) return cached
  const attempt = probeUserPath(options).then((userPath) => {
    if (!userPath) return false
    env.PATH = mergePath(env.PATH, userPath)
    return true
  })
  resolved.set(env, attempt)
  return attempt
}

// The login shell is the only authority for what the user actually has on
// PATH: Homebrew never touches /etc/paths.d, so path_helper cannot see
// `/opt/homebrew/bin` on a stock Apple Silicon machine. `-i` is required
// because users commonly export PATH in `.zshrc`, not `.zprofile`.
async function probeUserPath({
  execFile: run = nodeExecFile as unknown as ExecFileStub,
  shell = process.env.SHELL ?? "/bin/zsh",
  timeoutMs = 5_000,
}: ApplyUserShellPathOptions): Promise<string | undefined> {
  const stdout = await new Promise<string>((resolve, reject) => {
    run(shell, ["-lic", "echo $PATH"], { timeout: timeoutMs }, (error, output) => {
      if (error) reject(error)
      else resolve(String(output))
    })
  }).catch(() => undefined)
  // Interactive rc files may print anything before the `echo`; the PATH is the
  // last non-empty line because the echo runs last.
  return stdout?.split(/\r?\n/).filter(Boolean).pop()
}

function mergePath(existing: string | undefined, userPath: string): string {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const entry of [...userPath.split(":"), ...(existing ?? "").split(":")]) {
    if (entry && !seen.has(entry)) {
      seen.add(entry)
      merged.push(entry)
    }
  }
  return merged.join(":")
}