import { abortAfter } from "@/util/abort"

// PawWork bundles `uv` (packages/desktop-electron/bundled-tools.json) as the
// Python runtime supply for Excel/Word/PPT skills (#1273). On first use `uv`
// pulls two things over the network: a standalone CPython build, and PyPI
// package indexes. Both upstream defaults (GitHub releases + pypi.org) are
// slow or outright unreachable for a meaningful share of PawWork's mainland
// China user base, so we probe official-vs-mirror reachability/latency once
// per process and hand back the env vars `uv` reads to pick a source.
//
// Callers (shell tool, pty, session prompt bash) merge this into the child
// env unconditionally, the same way OFFICECLI_SKIP_UPDATE is always set
// regardless of whether the command touches officecli — they never need to
// know which source won, or whether a probe even ran.

export interface MirrorCandidate {
  /** Human-readable id, used only for logging/tests. */
  name: string
  url: string
}

export interface ProbeResult {
  reachable: boolean
  latencyMs: number | null
}

export type ProbeFn = (url: string, timeoutMs: number) => Promise<ProbeResult>

// "探测超时约 2 秒" — bounds the worst-case added latency for the first shell
// invocation in a process, since all candidates are probed in parallel.
export const PROBE_TIMEOUT_MS = 2000

// A reachable mirror only wins over a reachable official source when it is
// at least twice as fast — "官方源可达时优先官方源，镜像只做回退或明显更快
// 时选用". This avoids flapping to a mirror over noise-level differences.
export const MIRROR_PREFERENCE_FACTOR = 0.5

// Cached selection is reused for this long before re-probing. Long enough
// that a shell-heavy session doesn't re-probe the network on every tool
// call; short enough to notice a real network change (VPN toggle, moving
// networks) within a single working session.
export const CACHE_TTL_MS = 30 * 60 * 1000

export const PYTHON_INSTALL_OFFICIAL: MirrorCandidate = {
  name: "official",
  url: "https://github.com/astral-sh/python-build-standalone/releases",
}

export const PYTHON_INSTALL_MIRRORS: MirrorCandidate[] = [
  {
    name: "npmmirror",
    url: "https://registry.npmmirror.com/-/binary/python-build-standalone",
  },
]

export const PYPI_OFFICIAL: MirrorCandidate = {
  name: "official",
  url: "https://pypi.org/simple",
}

export const PYPI_MIRRORS: MirrorCandidate[] = [
  { name: "tuna", url: "https://pypi.tuna.tsinghua.edu.cn/simple" },
  { name: "aliyun", url: "https://mirrors.aliyun.com/pypi/simple" },
]

export async function defaultProbe(url: string, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now()
  const timeout = abortAfter(timeoutMs)
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: timeout.signal })
    return { reachable: response.ok, latencyMs: Date.now() - started }
  } catch {
    return { reachable: false, latencyMs: null }
  } finally {
    timeout.clearTimeout()
  }
}

/**
 * Probes `official` and every candidate in `mirrors` in parallel and picks a
 * winner: prefer a reachable official source unless a mirror is reachable
 * and at least MIRROR_PREFERENCE_FACTOR times faster; otherwise fall back to
 * the fastest reachable mirror; otherwise fall back to official itself so
 * uv's own network error surfaces instead of pointing at a dead mirror.
 */
export async function selectSource(
  official: MirrorCandidate,
  mirrors: MirrorCandidate[],
  probe: ProbeFn = defaultProbe,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<MirrorCandidate & ProbeResult> {
  const [officialResult, ...mirrorResults] = await Promise.all(
    [official, ...mirrors].map((candidate) => probe(candidate.url, timeoutMs)),
  )

  const reachableMirrors = mirrors
    .map((candidate, index) => ({ ...candidate, ...mirrorResults[index] }))
    .filter((candidate) => candidate.reachable)
    .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))

  if (officialResult.reachable) {
    const faster = reachableMirrors.find(
      (mirror) =>
        mirror.latencyMs !== null &&
        officialResult.latencyMs !== null &&
        mirror.latencyMs < officialResult.latencyMs * MIRROR_PREFERENCE_FACTOR,
    )
    if (faster) return faster
    return { ...official, ...officialResult }
  }

  if (reachableMirrors.length > 0) return reachableMirrors[0]
  return { ...official, ...officialResult }
}

export interface UvMirrorEnv {
  UV_PYTHON_INSTALL_MIRROR?: string
  UV_DEFAULT_INDEX?: string
}

let cache: { at: number; env: UvMirrorEnv } | null = null
let inflight: Promise<UvMirrorEnv> | null = null

/** Test-only: clears the in-process cache so each test probes fresh. */
export function resetUvMirrorCache() {
  cache = null
  inflight = null
}

/**
 * Resolves the env vars `uv` should be launched with. Returns {} (letting uv
 * fall back to its own official defaults) when the official sources win. The
 * probe-and-select result is cached in-process for CACHE_TTL_MS so repeated
 * shell/pty/prompt invocations in the same session don't re-probe the
 * network each time.
 */
export async function resolveUvMirrorEnv(probe: ProbeFn = defaultProbe): Promise<UvMirrorEnv> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.env
  if (inflight) return inflight

  inflight = (async () => {
    const [pythonInstall, pypiIndex] = await Promise.all([
      selectSource(PYTHON_INSTALL_OFFICIAL, PYTHON_INSTALL_MIRRORS, probe),
      selectSource(PYPI_OFFICIAL, PYPI_MIRRORS, probe),
    ])

    const env: UvMirrorEnv = {}
    if (pythonInstall.url !== PYTHON_INSTALL_OFFICIAL.url) env.UV_PYTHON_INSTALL_MIRROR = pythonInstall.url
    if (pypiIndex.url !== PYPI_OFFICIAL.url) env.UV_DEFAULT_INDEX = pypiIndex.url

    cache = { at: Date.now(), env }
    return env
  })()

  try {
    return await inflight
  } finally {
    inflight = null
  }
}
