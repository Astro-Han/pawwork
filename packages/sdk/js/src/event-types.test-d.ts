import type { Event, EventFileWatcherRescan } from "./gen/types.gen.js"

type Assert<T extends true> = T

type _RescanIsSdkEvent = Assert<EventFileWatcherRescan extends Event ? true : false>

const _rescan: EventFileWatcherRescan = {
  type: "file.watcher.rescan",
  properties: {
    directory: "/repo",
  },
}
