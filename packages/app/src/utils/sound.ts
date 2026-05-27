let files: Record<string, () => Promise<string>> | undefined
let loads: Record<SoundID, () => Promise<string>> | undefined

function getFiles() {
  if (files) return files
  files = import.meta.glob("../../../ui/src/assets/audio/*.aac", { import: "default" }) as Record<
    string,
    () => Promise<string>
  >
  return files
}

export type SoundID = "notify" | "error"

function getLoads() {
  if (loads) return loads
  loads = Object.fromEntries(
    Object.entries(getFiles()).flatMap(([path, load]) => {
      const file = path.split("/").at(-1)
      if (!file) return []
      return [[file.replace(/\.aac$/, ""), load] as const]
    }),
  ) as Record<SoundID, () => Promise<string>>
  return loads
}

const cache = new Map<SoundID, Promise<string | undefined>>()

function soundSrc(id: string | undefined) {
  const loads = getLoads()
  if (!id || !(id in loads)) return Promise.resolve(undefined)
  const key = id as SoundID
  const hit = cache.get(key)
  if (hit) return hit
  const next = loads[key]().catch(() => undefined)
  cache.set(key, next)
  return next
}

function playSound(src: string | undefined) {
  if (typeof Audio === "undefined") return
  if (!src) return
  const audio = new Audio(src)
  audio.play().catch(() => undefined)
  return () => {
    audio.pause()
    audio.currentTime = 0
  }
}

export function playSoundById(id: string | undefined) {
  return soundSrc(id).then((src) => playSound(src))
}
