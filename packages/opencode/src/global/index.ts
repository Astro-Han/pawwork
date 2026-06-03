import fs from "fs/promises"
import path from "path"
import { Filesystem } from "../util/filesystem"
import { Global, Path } from "@opencode-ai/core/global"
import { sweepScratch, SCRATCH_MAX_AGE_MS } from "./scratch"

export { Global }

const CACHE_VERSION = "21"

const version = await Filesystem.readText(path.join(Path.cache, "version")).catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch (e) {}
  await Filesystem.write(path.join(Path.cache, "version"), CACHE_VERSION)
}

// Drop agent ${tmp} scratch artifacts left untouched past the retention window so
// the scratch dir does not grow without bound (#945). Not awaited: startup must
// not block on it, and it is age-based, so a concurrently running opencode
// process's recent files are never swept.
void sweepScratch({ dir: Path.tmp, now: Date.now(), maxAgeMs: SCRATCH_MAX_AGE_MS }).catch(() => {})
