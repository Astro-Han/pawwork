import { randomUUID } from "node:crypto"
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

export function coerceOpenCliArgs(cmdArgs: Arg[], kwargs: CommandArgs): CommandArgs {
  const result = { ...kwargs }
  for (const argDef of cmdArgs) {
    const val = result[argDef.name]
    if (argDef.required && (val === undefined || val === null || val === "")) {
      throw new OpenCliArgumentError(`Argument "${argDef.name}" is required.`)
    }
    if (val !== undefined && val !== null) {
      if (argDef.type === "int" || argDef.type === "number") {
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

function urlMatchesDomain(url: string | null | undefined, domain: string | undefined) {
  if (!url || !domain) return false
  try {
    const hostname = new URL(url).hostname
    return hostname === domain || hostname.endsWith(`.${domain}`)
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
  return !urlMatchesDomain(currentUrl, cmd.domain)
}

export function resolveOpenCliSiteSession(cmd: CliCommand, override?: string): SiteSessionMode {
  if (override === "ephemeral" || override === "persistent") return override
  if (override !== undefined && override !== "") {
    throw new OpenCliArgumentError(`siteSession must be one of: ephemeral, persistent. Received: "${override}"`)
  }
  return cmd.siteSession ?? "ephemeral"
}

export function openCliAdapterSessionID(cmd: CliCommand, siteSession: SiteSessionMode) {
  if (siteSession === "persistent") return `site:${cmd.site}`
  return `site:${cmd.site}:${randomUUID()}`
}

export async function runOpenCliAdapterCommand(
  cmd: CliCommand,
  page: IPage | null,
  kwargs: CommandArgs,
  options: { debug?: boolean; siteSession?: SiteSessionMode } = {},
): Promise<unknown> {
  const debug = options.debug ?? false
  const siteSession = options.siteSession ?? resolveOpenCliSiteSession(cmd)
  const preNavUrl = resolveOpenCliPreNav(cmd)
  if (preNavUrl) {
    if (!page) throw new OpenCliCommandError(`Command ${fullName(cmd)} requires a browser session for pre-navigation`)
    if (await shouldRunOpenCliPreNav(cmd, page, siteSession, preNavUrl)) {
      await page.goto(preNavUrl)
    }
  }
  if (cmd.func) {
    if (cmd.browser === false) return cmd.func(kwargs, debug)
    if (!page) throw new OpenCliCommandError(`Command ${fullName(cmd)} requires a browser session but none was provided`)
    return cmd.func(page, kwargs, debug)
  }
  if (cmd.pipeline) return executePipeline(page, cmd.pipeline, { args: kwargs, debug })
  throw new OpenCliCommandError(`Command ${fullName(cmd)} has no func or pipeline`)
}
