import { abortAfter } from "@/util/abort"
import { envValueCaseInsensitive } from "@/util/env"

// PawWork bundles `uv` (packages/desktop-electron/bundled-tools.json) as the
// Python runtime supply for Excel/Word/PPT skills (#1273). On first use `uv`
// pulls two things over the network: a standalone CPython build, and PyPI
// package indexes. Both upstream defaults (GitHub releases + pypi.org) are
// slow or outright unreachable for a meaningful share of PawWork's mainland
// China user base, so we probe official-vs-mirror reachability and hand back
// the env vars `uv` reads to pick a source.
//
// Selection rule: official wins whenever it is reachable; mirrors are a
// fallback only. A HEAD probe measures RTT, not download throughput, so
// "mirror looks faster" is not evidence the mirror downloads faster — we
// deliberately do NOT switch away from a reachable official source.
//
// Callers (shell tool, pty, session prompt bash) apply the snapshot into the
// child env on every spawn, but only for keys the user has not already
// defined, so an explicitly configured UV_DEFAULT_INDEX /
// UV_PYTHON_INSTALL_MIRROR (e.g. a corporate index) is never overridden.

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

// Probe timeout budget (~2s). Probes never block a child process spawn —
// see uvMirrorEnvSnapshot — so this only bounds how long a background
// refresh keeps running.
export const PROBE_TIMEOUT_MS = 2000

// A cached selection is reused for this long before a background re-probe.
// Long enough that a shell-heavy session doesn't re-probe constantly; short
// enough to notice a real network change (VPN toggle, moving networks)
// within a working session.
export const CACHE_TTL_MS = 30 * 60 * 1000

export const PYTHON_INSTALL_OFFICIAL: MirrorCandidate = {
  name: "official",
  url: "https://github.com/astral-sh/python-build-standalone/releases",
}

// Verified 2026-07-08: npmmirror serves the exact `${mirror}/${tag}/${asset}`
// path shape uv requests (fetched SHA256SUMS and byte-compared a cpython
// asset prefix against the official release — identical).
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

// Any HTTP response proves the host is reachable for our purposes. Some CDNs
// reject HEAD with 405, and a redirect that fetch didn't follow (or a
// trailing-slash 301) still means the origin is alive — treat those as
// reachable rather than failing over to a mirror.
export function probeStatusReachable(status: number): boolean {
  if (status >= 200 && status < 400) return true
  if (status === 405) return true
  return false
}

export async function defaultProbe(url: string, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now()
  const timeout = abortAfter(timeoutMs)
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: timeout.signal })
    return { reachable: probeStatusReachable(response.status), latencyMs: Date.now() - started }
  } catch {
    return { reachable: false, latencyMs: null }
  } finally {
    timeout.clearTimeout()
  }
}

/**
 * Probes `official` and every candidate in `mirrors` in parallel and picks a
 * winner: a reachable official source always wins; otherwise the fastest
 * reachable mirror; otherwise official itself so uv's own network error
 * surfaces instead of pointing at a dead mirror.
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

  if (officialResult.reachable) return { ...official, ...officialResult }

  const reachableMirrors = mirrors
    .map((candidate, index) => ({ ...candidate, ...mirrorResults[index] }))
    .filter((candidate) => candidate.reachable)
    .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))

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
 * Runs the probe-and-select and stores the result in the in-process cache.
 * Concurrent callers share one in-flight run. Never throws: probe failures
 * degrade to "official everywhere", i.e. an empty env.
 */
export function prewarmUvMirrorCache(probe: ProbeFn = defaultProbe): Promise<UvMirrorEnv> {
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

  return inflight.finally(() => {
    inflight = null
  })
}

/**
 * Returns the current mirror env without ever blocking: a fresh cached
 * selection if one exists, otherwise the last known selection (stale) or {}
 * (first call in the process), while a background prewarm refreshes the
 * cache for subsequent calls. An empty result means "let uv use its own
 * official defaults", which is the correct no-information behavior — the
 * probe must never delay spawning a child process that most likely does not
 * even invoke uv.
 */
export function uvMirrorEnvSnapshot(probe: ProbeFn = defaultProbe): UvMirrorEnv {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.env
  void prewarmUvMirrorCache(probe)
  return cache?.env ?? {}
}

/**
 * Copies each snapshot entry into `env` unless the key is already present
 * (case-insensitively — Windows env keys are case-insensitive, so a
 * user-set `uv_default_index` must also block our `UV_DEFAULT_INDEX`).
 * User- or plugin-provided values always win over probed fallbacks.
 */
export function applyUvMirrorEnvDefaults(env: Record<string, string | undefined>, snapshot: UvMirrorEnv): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) continue
    if (envValueCaseInsensitive(env, key) !== undefined) continue
    env[key] = value
  }
}
