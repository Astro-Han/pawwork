import { BrowserViewController } from "./controller"
import { BrowserControllerRegistry } from "./registry"

/** Single main-process instance of the conversation-view registry (see registry.ts). */
export const browserControllers = new BrowserControllerRegistry((key: string) => new BrowserViewController(key))
