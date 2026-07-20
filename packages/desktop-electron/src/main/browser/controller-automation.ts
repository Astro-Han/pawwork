import { join } from "node:path"
import { app, session } from "electron"
import { BrowserViewController } from "./controller"
import { BrowserControllerRegistry } from "./registry"
import { BrowserProfileRegistry } from "./profile-registry"
import { BrowserProfileSessions } from "./profile-sessions"
import { getStore } from "../store"
import { PAWWORK_RUNTIME } from "../runtime-namespace"

const PROFILE_MAP_KEY = "profiles"

export const browserProfiles = new BrowserProfileRegistry({
  read: () => getStore(PAWWORK_RUNTIME.browserProfilesStore).get(PROFILE_MAP_KEY),
  write: (profiles) => getStore(PAWWORK_RUNTIME.browserProfilesStore).set(PROFILE_MAP_KEY, profiles),
})

export const browserProfileSessions = new BrowserProfileSessions({
  rootPath: () => join(app.getPath("sessionData"), PAWWORK_RUNTIME.browserProfilesDirectory),
  fromPath: (path) => session.fromPath(path),
})

/** Single main-process instance of the conversation-view registry (see registry.ts). */
export const browserControllers = new BrowserControllerRegistry((key: string) => {
  const profileID = browserProfiles.profileFor(key)
  return new BrowserViewController(
    key,
    browserProfileSessions.sessionFor(profileID),
    (sessionID) => browserProfiles.adopt(sessionID, profileID),
  )
})
