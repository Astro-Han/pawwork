import { EOL } from "os"
import { Project } from "../../../project/project"
import { Log } from "@opencode-ai/core/util/log"
import { cmd } from "../cmd"
import { AppRuntime } from "../../../effect/app-runtime"

export const ScrapCommand = cmd({
  command: "scrap",
  describe: "list all known projects",
  builder: (yargs) => yargs,
  async handler() {
    const timer = Log.Default.time("scrap")
    const list = await AppRuntime.runPromise(Project.Service.use((project) => project.list()))
    process.stdout.write(JSON.stringify(list, null, 2) + EOL)
    timer.stop()
  },
})
