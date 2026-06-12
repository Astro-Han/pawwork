import { executePipeline } from "@jackwener/opencli/pipeline"
import { fullName, type Arg, type CliCommand, type CommandArgs, type IPage, type SiteSessionMode } from "@jackwener/opencli/registry"

export class OpenCliArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpenCliArgumentError"
  }
}

export class OpenCliCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpenCliCommandError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readNodeID(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null
  const nodeID = value[key]
  return typeof nodeID === "number" ? nodeID : null
}

type BrowserPermissionCheck = (patterns: string[], metadata?: Record<string, unknown>) => Promise<void>

const UNGUARDED_PAGE_METHODS = new Set(["getActivePage", "getCurrentUrl", "setActivePage", "wait", "waitForTimeout"])
const RECHECK_AFTER_PAGE_METHODS = new Set([
  "click",
  "closeTab",
  "cdp",
  "dblClick",
  "evaluate",
  "evaluateWithArgs",
  "goto",
  "handleJavaScriptDialog",
  "nativeClick",
  "newTab",
  "pressKey",
  "selectTab",
])

function currentBrowserPermissionPattern(url: string | null | undefined) {
  if (!url) return "*"
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "*"
  } catch {
    return "*"
  }
}

function targetBrowserPermissionPattern(cmd: CliCommand, url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href
  } catch {
    // fall through to the command-specific error below
  }
  throw new OpenCliCommandError(`Command ${fullName(cmd)} tried to navigate to unsupported URL: ${JSON.stringify(url)}`)
}

async function askCurrentBrowserPermission(
  cmd: CliCommand,
  page: IPage,
  askBrowserPermission: BrowserPermissionCheck | undefined,
  operation: string,
) {
  if (!askBrowserPermission) return
  const currentUrl = await page.getCurrentUrl?.().catch(() => null)
  await askBrowserPermission([currentBrowserPermissionPattern(currentUrl)], { operation, command: fullName(cmd) })
}

async function withCurrentBrowserPermission<T>(
  cmd: CliCommand,
  page: IPage,
  askBrowserPermission: BrowserPermissionCheck | undefined,
  operation: string,
  run: () => Promise<T>,
  recheckAfter = false,
): Promise<T> {
  await askCurrentBrowserPermission(cmd, page, askBrowserPermission, operation)
  const result = await run()
  if (recheckAfter) await askCurrentBrowserPermission(cmd, page, askBrowserPermission, `${operation}:after`)
  return result
}

async function withTargetBrowserPermission<T>(
  cmd: CliCommand,
  page: IPage,
  askBrowserPermission: BrowserPermissionCheck | undefined,
  operation: string,
  url: string,
  run: () => Promise<T>,
): Promise<T> {
  if (askBrowserPermission) {
    await askBrowserPermission([targetBrowserPermissionPattern(cmd, url)], { operation, command: fullName(cmd) })
  }
  const result = await run()
  await askCurrentBrowserPermission(cmd, page, askBrowserPermission, `${operation}:after`)
  return result
}

async function cdpSetFileInput(cmd: CliCommand, page: IPage, files: string[], selector = 'input[type="file"]') {
  const cdp = page.cdp
  if (typeof cdp !== "function") {
    throw new OpenCliCommandError(`Command ${fullName(cmd)} needs setFileInput, but this browser backend does not expose CDP.`)
  }
  await cdp.call(page, "DOM.enable", {}).catch(() => undefined)
  const documentResult = await cdp.call(page, "DOM.getDocument", {})
  const root = isRecord(documentResult) && isRecord(documentResult.root) ? documentResult.root : undefined
  const rootNodeID = readNodeID(root, "nodeId")
  if (rootNodeID === null) throw new OpenCliCommandError("DOM.getDocument returned no root node.")
  const queryResult = await cdp.call(page, "DOM.querySelector", { nodeId: rootNodeID, selector })
  const nodeID = readNodeID(queryResult, "nodeId")
  if (nodeID === null || nodeID <= 0) throw new OpenCliCommandError(`No file input matched selector: ${selector}`)
  await cdp.call(page, "DOM.setFileInputFiles", { files, nodeId: nodeID })
}

async function cdpInsertText(cmd: CliCommand, page: IPage, text: string) {
  const cdp = page.cdp
  if (typeof cdp !== "function") {
    throw new OpenCliCommandError(`Command ${fullName(cmd)} needs insertText, but this browser backend does not expose CDP.`)
  }
  await cdp.call(page, "Input.insertText", { text })
}

async function cdpNativeClick(cmd: CliCommand, page: IPage, x: number, y: number) {
  const cdp = page.cdp
  if (typeof cdp !== "function") {
    throw new OpenCliCommandError(`Command ${fullName(cmd)} needs nativeClick, but this browser backend does not expose CDP.`)
  }
  await cdp.call(page, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
  await cdp.call(page, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
  await cdp.call(page, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
}

export function createOpenCliAdapterPage(
  cmd: CliCommand,
  page: IPage,
  options: { askBrowserPermission?: BrowserPermissionCheck } = {},
): IPage {
  return new Proxy(page, {
    get(target, prop, receiver) {
      if (prop === "then") return undefined
      if (prop === "closeWindow") return async () => {}
      if (prop === "goto") {
        const goto = target.goto.bind(target) as (url: string, ...args: unknown[]) => Promise<void>
        return (url: string, ...args: unknown[]) =>
          withTargetBrowserPermission(cmd, target, options.askBrowserPermission, "goto", url, () =>
            goto(url, ...args),
          )
      }
      if (prop === "fetchJson") {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value === "function") {
          const fetchJson = value.bind(target) as (url: string, ...args: unknown[]) => Promise<unknown>
          return (url: string, ...args: unknown[]) =>
            withTargetBrowserPermission(cmd, target, options.askBrowserPermission, "fetchJson", url, () =>
              fetchJson(url, ...args),
            )
        }
      }
      if (prop === "setFileInput" && typeof target.setFileInput !== "function" && typeof target.cdp === "function") {
        return (files: string[], selector?: string) =>
          withCurrentBrowserPermission(cmd, target, options.askBrowserPermission, "setFileInput", () =>
            cdpSetFileInput(cmd, target, files, selector),
          )
      }
      if (prop === "insertText" && typeof target.insertText !== "function" && typeof target.cdp === "function") {
        return (text: string) =>
          withCurrentBrowserPermission(cmd, target, options.askBrowserPermission, "insertText", () =>
            cdpInsertText(cmd, target, text),
          )
      }
      if (prop === "nativeType" && typeof target.cdp === "function") {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === "function"
          ? (text: string) =>
              withCurrentBrowserPermission(cmd, target, options.askBrowserPermission, "nativeType", () =>
                value.call(target, text),
              )
          : (text: string) =>
              withCurrentBrowserPermission(cmd, target, options.askBrowserPermission, "nativeType", () =>
                cdpInsertText(cmd, target, text),
              )
      }
      if (prop === "nativeClick" && typeof target.cdp === "function") {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === "function"
          ? (x: number, y: number) =>
              withCurrentBrowserPermission(cmd, target, options.askBrowserPermission, "nativeClick", () =>
                value.call(target, x, y),
                true,
              )
          : (x: number, y: number) =>
              withCurrentBrowserPermission(cmd, target, options.askBrowserPermission, "nativeClick", () =>
                cdpNativeClick(cmd, target, x, y),
                true,
              )
      }
      if (prop === "waitForTimeout") {
        const value = Reflect.get(target, prop, receiver)
        return typeof value === "function" ? value.bind(target) : (ms: number) => target.wait(ms / 1000)
      }
      const value = Reflect.get(target, prop, receiver)
      if (typeof prop === "string" && typeof value === "function" && !UNGUARDED_PAGE_METHODS.has(prop)) {
        return (...args: unknown[]) =>
          withCurrentBrowserPermission(
            cmd,
            target,
            options.askBrowserPermission,
            prop,
            () => value.call(target, ...args),
            RECHECK_AFTER_PAGE_METHODS.has(prop),
          )
      }
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

export function coerceOpenCliArgs(cmdArgs: Arg[], kwargs: CommandArgs): CommandArgs {
  const result = { ...kwargs }
  for (const argDef of cmdArgs) {
    const val = result[argDef.name]
    if (argDef.required && (val === undefined || val === null || val === "")) {
      throw new OpenCliArgumentError(`Argument "${argDef.name}" is required.`)
    }
    if (val !== undefined && val !== null) {
      if (argDef.type === "int" || argDef.type === "number") {
        if (typeof val === "string" && val.trim() === "") {
          throw new OpenCliArgumentError(`Argument "${argDef.name}" must be a valid number. Received: "${val}"`)
        }
        const num = Number(val)
        if (Number.isNaN(num)) {
          throw new OpenCliArgumentError(`Argument "${argDef.name}" must be a valid number. Received: "${val}"`)
        }
        result[argDef.name] = num
      } else if (argDef.type === "boolean" || argDef.type === "bool") {
        if (typeof val === "string") {
          const lower = val.toLowerCase()
          if (lower === "true" || lower === "1") result[argDef.name] = true
          else if (lower === "false" || lower === "0") result[argDef.name] = false
          else throw new OpenCliArgumentError(`Argument "${argDef.name}" must be a boolean (true/false). Received: "${val}"`)
        } else {
          result[argDef.name] = Boolean(val)
        }
      }
      const coercedVal = result[argDef.name]
      if (argDef.choices && argDef.choices.length > 0 && !argDef.choices.map(String).includes(String(coercedVal))) {
        throw new OpenCliArgumentError(
          `Argument "${argDef.name}" must be one of: ${argDef.choices.join(", ")}. Received: "${coercedVal}"`,
        )
      }
    } else if (argDef.default !== undefined) {
      result[argDef.name] = argDef.default
    }
  }
  return result
}

export function prepareOpenCliCommandArgs(cmd: CliCommand, rawKwargs: CommandArgs): CommandArgs {
  const kwargs = coerceOpenCliArgs(cmd.args, rawKwargs)
  cmd.validateArgs?.(kwargs)
  return kwargs
}

export function resolveOpenCliPreNav(cmd: CliCommand): string | null {
  if (cmd.navigateBefore === false) return null
  if (typeof cmd.navigateBefore === "string") return cmd.navigateBefore
  return null
}

function urlMatchesOrigin(url: string | null | undefined, originUrl: string) {
  if (!url) return false
  try {
    return new URL(url).origin === new URL(originUrl).origin
  } catch {
    return false
  }
}

function isDomainRootPreNav(preNavUrl: string, domain: string | undefined) {
  if (!domain) return false
  try {
    const parsed = new URL(preNavUrl)
    const hostnameMatches = parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
    const rootPath = parsed.pathname === "" || parsed.pathname === "/"
    return hostnameMatches && rootPath && parsed.search === "" && parsed.hash === ""
  } catch {
    return false
  }
}

export async function shouldRunOpenCliPreNav(
  cmd: CliCommand,
  page: Pick<IPage, "getCurrentUrl">,
  siteSession: SiteSessionMode,
  preNavUrl: string,
) {
  if (siteSession !== "persistent" || !cmd.domain) return true
  if (!isDomainRootPreNav(preNavUrl, cmd.domain)) return true
  const currentUrl = await page.getCurrentUrl?.().catch(() => null)
  return !urlMatchesOrigin(currentUrl, preNavUrl)
}

function resolveOpenCliSiteSession(cmd: CliCommand): SiteSessionMode {
  return cmd.siteSession ?? "ephemeral"
}

export async function runOpenCliAdapterCommand(
  cmd: CliCommand,
  page: IPage | null,
  kwargs: CommandArgs,
  options: { debug?: boolean; askBrowserPermission?: BrowserPermissionCheck } = {},
): Promise<unknown> {
  const debug = options.debug ?? false
  const siteSession = resolveOpenCliSiteSession(cmd)
  const adapterPage = page ? createOpenCliAdapterPage(cmd, page, options) : null
  const resetAfter = cmd.browser !== false && siteSession === "ephemeral" && adapterPage
  try {
    const preNavUrl = resolveOpenCliPreNav(cmd)
    if (preNavUrl) {
      if (!page || !adapterPage)
        throw new OpenCliCommandError(`Command ${fullName(cmd)} requires a browser session for pre-navigation`)
      if (await shouldRunOpenCliPreNav(cmd, adapterPage, siteSession, preNavUrl)) {
        await page.goto(preNavUrl)
      }
    }
    if (cmd.func) {
      if (cmd.browser === false) return cmd.func(kwargs, debug)
      if (!adapterPage) throw new OpenCliCommandError(`Command ${fullName(cmd)} requires a browser session but none was provided`)
      return cmd.func(adapterPage, kwargs, debug)
    }
    if (cmd.pipeline) return executePipeline(adapterPage, cmd.pipeline, { args: kwargs, debug })
    throw new OpenCliCommandError(`Command ${fullName(cmd)} has no func or pipeline`)
  } finally {
    if (resetAfter) await adapterPage.goto("about:blank").catch(() => undefined)
  }
}

export * as AdapterRunner from "./adapter-runner"
