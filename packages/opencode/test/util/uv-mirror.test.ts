import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  applyUvMirrorEnvDefaults,
  probeStatusReachable,
  PROBE_TIMEOUT_MS,
  PYPI_MIRRORS,
  PYPI_OFFICIAL,
  PYTHON_INSTALL_MIRRORS,
  PYTHON_INSTALL_OFFICIAL,
  prewarmUvMirrorCache,
  resetUvMirrorCache,
  selectSource,
  uvMirrorEnvSnapshot,
  type MirrorCandidate,
  type ProbeFn,
} from "../../src/util/uv-mirror"

function fixedProbe(latencies: Record<string, number | null>): ProbeFn {
  return async (url: string) => {
    const latencyMs = latencies[url]
    if (latencyMs === undefined) throw new Error(`No fixture latency for ${url}`)
    return { reachable: latencyMs !== null, latencyMs }
  }
}

const official: MirrorCandidate = { name: "official", url: "https://official.example/" }
const mirrorA: MirrorCandidate = { name: "mirror-a", url: "https://mirror-a.example/" }
const mirrorB: MirrorCandidate = { name: "mirror-b", url: "https://mirror-b.example/" }

describe("uv-mirror.selectSource", () => {
  test("a reachable official source always wins, even when a mirror probes faster", async () => {
    // A HEAD probe measures RTT, not download throughput — a lower probe
    // latency is not evidence the mirror downloads faster, so official must
    // win whenever it responds at all.
    const probe = fixedProbe({ [official.url]: 1000, [mirrorA.url]: 50 })
    const result = await selectSource(official, [mirrorA], probe)
    expect(result.url).toBe(official.url)
  })

  test("falls back to the fastest reachable mirror when official is unreachable", async () => {
    const probe = fixedProbe({ [official.url]: null, [mirrorA.url]: 300, [mirrorB.url]: 120 })
    const result = await selectSource(official, [mirrorA, mirrorB], probe)
    expect(result.url).toBe(mirrorB.url)
  })

  test("falls back to official when nothing is reachable, so uv's own error surfaces", async () => {
    const probe = fixedProbe({ [official.url]: null, [mirrorA.url]: null })
    const result = await selectSource(official, [mirrorA], probe)
    expect(result.url).toBe(official.url)
    expect(result.reachable).toBe(false)
  })

  test("probes every candidate with the configured timeout, not a hardcoded one", async () => {
    const seenTimeouts: number[] = []
    const probe: ProbeFn = async (_url, timeoutMs) => {
      seenTimeouts.push(timeoutMs)
      return { reachable: true, latencyMs: 10 }
    }
    await selectSource(official, [mirrorA], probe, 500)
    expect(seenTimeouts).toEqual([500, 500])
  })

  test("default probe timeout matches the ~2s budget", () => {
    expect(PROBE_TIMEOUT_MS).toBe(2000)
  })
})

describe("uv-mirror.probeStatusReachable", () => {
  test("treats 2xx as reachable", () => {
    expect(probeStatusReachable(200)).toBe(true)
    expect(probeStatusReachable(204)).toBe(true)
  })

  test("treats redirects as reachable (host is alive even if fetch surfaced the 3xx)", () => {
    expect(probeStatusReachable(301)).toBe(true)
    expect(probeStatusReachable(308)).toBe(true)
  })

  test("treats 405 Method Not Allowed as reachable (CDNs that reject HEAD)", () => {
    expect(probeStatusReachable(405)).toBe(true)
  })

  test("treats other client and server errors as unreachable", () => {
    expect(probeStatusReachable(403)).toBe(false)
    expect(probeStatusReachable(404)).toBe(false)
    expect(probeStatusReachable(500)).toBe(false)
    expect(probeStatusReachable(502)).toBe(false)
  })
})

describe("uv-mirror.uvMirrorEnvSnapshot", () => {
  beforeEach(() => resetUvMirrorCache())
  afterEach(() => resetUvMirrorCache())

  const allOfficialUp = fixedProbe({
    [PYTHON_INSTALL_OFFICIAL.url]: 50,
    [PYTHON_INSTALL_MIRRORS[0].url]: 40,
    [PYPI_OFFICIAL.url]: 50,
    [PYPI_MIRRORS[0].url]: 45,
    [PYPI_MIRRORS[1].url]: 45,
  })

  const allOfficialDown = fixedProbe({
    [PYTHON_INSTALL_OFFICIAL.url]: null,
    [PYTHON_INSTALL_MIRRORS[0].url]: 200,
    [PYPI_OFFICIAL.url]: null,
    [PYPI_MIRRORS[0].url]: 300,
    [PYPI_MIRRORS[1].url]: 150,
  })

  test("returns {} immediately on first call and never blocks on the probe", async () => {
    let resolveProbe: (() => void) | null = null
    const gate = new Promise<void>((resolve) => (resolveProbe = resolve))
    const probe: ProbeFn = async (url, timeoutMs) => {
      await gate // probe hangs until we explicitly release it
      return allOfficialDown(url, timeoutMs)
    }
    // Snapshot must return synchronously with {} while the probe is stuck.
    const first = uvMirrorEnvSnapshot(probe)
    expect(first).toEqual({})
    resolveProbe!()
    await prewarmUvMirrorCache(probe) // shares/awaits the background run
    const second = uvMirrorEnvSnapshot(probe)
    expect(second.UV_DEFAULT_INDEX).toBe(PYPI_MIRRORS[1].url)
  })

  test("omits both env vars when official sources are reachable", async () => {
    await prewarmUvMirrorCache(allOfficialUp)
    expect(uvMirrorEnvSnapshot(allOfficialUp)).toEqual({})
  })

  test("sets UV_PYTHON_INSTALL_MIRROR and UV_DEFAULT_INDEX when official is unreachable", async () => {
    await prewarmUvMirrorCache(allOfficialDown)
    const env = uvMirrorEnvSnapshot(allOfficialDown)
    expect(env.UV_PYTHON_INSTALL_MIRROR).toBe(PYTHON_INSTALL_MIRRORS[0].url)
    expect(env.UV_DEFAULT_INDEX).toBe(PYPI_MIRRORS[1].url) // aliyun: faster of the two reachable mirrors
  })

  test("a warm cache is reused without re-probing", async () => {
    let calls = 0
    const countingProbe: ProbeFn = async (url, timeoutMs) => {
      calls += 1
      return allOfficialUp(url, timeoutMs)
    }
    await prewarmUvMirrorCache(countingProbe)
    const callsAfterPrewarm = calls
    uvMirrorEnvSnapshot(countingProbe)
    uvMirrorEnvSnapshot(countingProbe)
    expect(calls).toBe(callsAfterPrewarm)
  })

  test("concurrent prewarms share a single in-flight probe run", async () => {
    let calls = 0
    const countingProbe: ProbeFn = async (url, timeoutMs) => {
      calls += 1
      return allOfficialUp(url, timeoutMs)
    }
    const [a, b] = await Promise.all([prewarmUvMirrorCache(countingProbe), prewarmUvMirrorCache(countingProbe)])
    expect(a).toEqual(b)
    // 2 python-install candidates + 3 pypi candidates, probed exactly once
    expect(calls).toBe(5)
  })
})

describe("uv-mirror.applyUvMirrorEnvDefaults", () => {
  test("fills missing keys", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" }
    applyUvMirrorEnvDefaults(env, {
      UV_DEFAULT_INDEX: "https://mirror.example/simple",
      UV_PYTHON_INSTALL_MIRROR: "https://mirror.example/pbs",
    })
    expect(env.UV_DEFAULT_INDEX).toBe("https://mirror.example/simple")
    expect(env.UV_PYTHON_INSTALL_MIRROR).toBe("https://mirror.example/pbs")
  })

  test("never overrides a user-set value, even with different key casing", () => {
    // Windows env keys are case-insensitive: a user-set `uv_default_index`
    // must block our canonical UV_DEFAULT_INDEX too.
    const env: Record<string, string | undefined> = {
      uv_default_index: "https://corp.example/private-simple",
      UV_PYTHON_INSTALL_MIRROR: "https://corp.example/pbs",
    }
    applyUvMirrorEnvDefaults(env, {
      UV_DEFAULT_INDEX: "https://mirror.example/simple",
      UV_PYTHON_INSTALL_MIRROR: "https://mirror.example/pbs",
    })
    expect(env.uv_default_index).toBe("https://corp.example/private-simple")
    expect(env.UV_DEFAULT_INDEX).toBeUndefined()
    expect(env.UV_PYTHON_INSTALL_MIRROR).toBe("https://corp.example/pbs")
  })

  test("an empty snapshot is a no-op", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" }
    applyUvMirrorEnvDefaults(env, {})
    expect(env).toEqual({ PATH: "/usr/bin" })
  })
})
