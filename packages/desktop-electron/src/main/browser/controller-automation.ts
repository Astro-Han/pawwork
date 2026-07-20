import { BrowserViewController } from "./controller"
import { BrowserControllerRegistry } from "./registry"
import { BrowserProfileRegistry } from "./profile-registry"
import { getStore } from "../store"
import { PAWWORK_RUNTIME } from "../runtime-namespace"

const PROFILE_MAP_KEY = "profiles"

export const browserProfiles = new BrowserProfileRegistry({
  read: () => getStore(PAWWORK_RUNTIME.browserProfilesStore).get(PROFILE_MAP_KEY),
  write: (profiles) => getStore(PAWWORK_RUNTIME.browserProfilesStore).set(PROFILE_MAP_KEY, profiles),
})

/** Single main-process instance of the conversation-view registry (see registry.ts). */
export const browserControllers = new BrowserControllerRegistry((key: string) => {
  const profileID = browserProfiles.profileFor(key)
  return new BrowserViewController(key, profileID, (sessionID) => browserProfiles.adopt(sessionID, profileID))
})
