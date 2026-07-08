import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  MIRROR_PREFERENCE_FACTOR,
  PROBE_TIMEOUT_MS,
  PYPI_MIRRORS,
  PYPI_OFFICIAL,
  PYTHON_INSTALL_MIRRORS,
  PYTHON_INSTALL_OFFICIAL,
  resetUvMirrorCache,
  resolveUvMirrorEnv,
  selectSource,
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
  test("prefers a reachable official source over a reachable mirror by default", async () => {
    const probe = fixedProbe({ [official.url]: 100, [mirrorA.url]: 80 })
    const result = await selectSource(official, [mirrorA], probe)
    expect(result.url).toBe(official.url)
  })

  test("prefers a mirror that is meaningfully faster than a reachable official source", async () => {
    // mirror latency is well under official * MIRROR_PREFERENCE_FACTOR
    const probe = fixedProbe({ [official.url]: 1000, [mirrorA.url]: 100 })
    const result = await selectSource(official, [mirrorA], probe)
    expect(result.url).toBe(mirrorA.url)
  })

  test("does not switch to a mirror that is only marginally faster", async () => {
    const officialLatency = 1000
    const justUnderThreshold = officialLatency * MIRROR_PREFERENCE_FACTOR + 1
    const probe = fixedProbe({ [official.url]: officialLatency, [mirrorA.url]: justUnderThreshold })
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

describe("uv-mirror.resolveUvMirrorEnv", () => {
  beforeEach(() => resetUvMirrorCache())
  afterEach(() => resetUvMirrorCache())

  test("omits both env vars when official sources win for both python and pypi", async () => {
    const probe = fixedProbe({
      [PYTHON_INSTALL_OFFICIAL.url]: 50,
      [PYTHON_INSTALL_MIRRORS[0].url]: 40,
      [PYPI_OFFICIAL.url]: 50,
      [PYPI_MIRRORS[0].url]: 45,
      [PYPI_MIRRORS[1].url]: 45,
    })
    const env = await resolveUvMirrorEnv(probe)
    expect(env).toEqual({})
  })

  test("sets UV_PYTHON_INSTALL_MIRROR and UV_DEFAULT_INDEX when official is unreachable", async () => {
    const probe = fixedProbe({
      [PYTHON_INSTALL_OFFICIAL.url]: null,
      [PYTHON_INSTALL_MIRRORS[0].url]: 200,
      [PYPI_OFFICIAL.url]: null,
      [PYPI_MIRRORS[0].url]: 300,
      [PYPI_MIRRORS[1].url]: 150,
    })
    const env = await resolveUvMirrorEnv(probe)
    expect(env.UV_PYTHON_INSTALL_MIRROR).toBe(PYTHON_INSTALL_MIRRORS[0].url)
    expect(env.UV_DEFAULT_INDEX).toBe(PYPI_MIRRORS[1].url) // aliyun: faster of the two reachable mirrors
  })

  test("caches the result so a second call does not re-probe", async () => {
    let calls = 0
    const probe: ProbeFn = async (url) => {
      calls += 1
      return { reachable: url === PYPI_OFFICIAL.url || url === PYTHON_INSTALL_OFFICIAL.url, latencyMs: 10 }
    }
    const first = await resolveUvMirrorEnv(probe)
    const callsAfterFirst = calls
    const second = await resolveUvMirrorEnv(probe)
    expect(second).toEqual(first)
    expect(calls).toBe(callsAfterFirst)
  })

  test("concurrent calls before the first probe resolves share a single in-flight probe", async () => {
    let calls = 0
    const probe: ProbeFn = async (url) => {
      calls += 1
      return { reachable: url === PYPI_OFFICIAL.url || url === PYTHON_INSTALL_OFFICIAL.url, latencyMs: 10 }
    }
    const [a, b] = await Promise.all([resolveUvMirrorEnv(probe), resolveUvMirrorEnv(probe)])
    expect(a).toEqual(b)
    // 2 python-install candidates + 3 pypi candidates, probed exactly once despite two concurrent callers
    expect(calls).toBe(5)
  })
})
