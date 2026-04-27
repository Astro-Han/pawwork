import fs from "fs/promises"
import path from "path"
import { Filesystem } from "../util/filesystem"
import { Global, Path } from "@opencode-ai/core/global"

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
