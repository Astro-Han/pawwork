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
}

// The only production caller kicks this off once at startup and awaits the
// same promise, so a per-session cache would serve no one — and a cached
// failure would permanently lock a hypothetical recovery caller out.
// Re-probing is harmless; do not add one preemptively.

// GUI launches hand the app launchd's minimal PATH, so user-installed CLIs
// (`/opt/homebrew/bin`, …) are invisible to every child we spawn. Resolving the
// login shell's own PATH once and merging it into `process.env` fixes that for
// all children at once; `prepareDshToolsEnvironment` still prepends our pinned
// tool dirs on top.
export function applyUserShellPath(options: ApplyUserShellPathOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env
  if ((options.platform ?? process.platform) !== "darwin") return Promise.resolve(false)
  return probeUserPath(options).then((userPath) => {
    if (!userPath) return false
    env.PATH = mergePath(env.PATH, userPath)
    return true
  })
}

// The login shell is the only authority for what the user actually has on
// PATH: Homebrew never touches /etc/paths.d, so path_helper cannot see
// `/opt/homebrew/bin` on a stock Apple Silicon machine. `-i` is required
// because users commonly export PATH in `.zshrc`, not `.zprofile`. A slow rc
// file is capped at 5s; past that we fall back to the inherited PATH.
const PROBE_TIMEOUT_MS = 5_000

// Unique enough that rc files are unlikely to print it; the marker also keeps
// the probe working when a shell prints before or after our command. fish
// joins "$PATH" with spaces inside double quotes, so the fish branch below is
// unaffected.
const PATH_MARKER = "__pawwork_shell_path__"

async function probeUserPath({
  execFile: run = nodeExecFile as unknown as ExecFileStub,
}: ApplyUserShellPathOptions): Promise<string[] | undefined> {
  const shell = process.env.SHELL ?? "/bin/zsh"
  const stdout = await new Promise<string>((resolve, reject) => {
    run(shell, ["-lic", `printf "${PATH_MARKER}%s\\n" "$PATH"`], { timeout: PROBE_TIMEOUT_MS }, (error, output) => {
      if (error) reject(error)
      else resolve(String(output))
    })
  }).catch(() => undefined)
  // Extract the marked line instead of trusting the last one: rc hooks (zshexit
  // and friends) can print after our command runs.
  const marked = stdout
    ?.split(/\r?\n/)
    .filter((line) => line.startsWith(PATH_MARKER))
    .pop()
  if (!marked) return undefined
  const lastLine = marked.slice(PATH_MARKER.length)
  if (!lastLine) return undefined
  // POSIX shells always print a colon-joined PATH; fish prints its PATH list
  // space-separated instead.
  return lastLine.includes(":") ? lastLine.split(":") : lastLine.split(/\s+/)
}

function mergePath(existing: string | undefined, userPath: string[]): string {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const entry of [...userPath, ...(existing ?? "").split(":")]) {
    if (entry && !seen.has(entry)) {
      seen.add(entry)
      merged.push(entry)
    }
  }
  return merged.join(":")
}