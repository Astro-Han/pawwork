import { mkdirSync } from "fs"
import os from "os"
import path from "path"
import type { UpgradeWebSocket } from "hono/ws"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Runtime } from "@opencode-ai/core/runtime"
import { Context, Effect, Layer } from "effect"
import { Etag, HttpEffect, HttpServerRequest, HttpServerResponse, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import type { WorkspaceID } from "@/control-plane/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Global } from "@/global"
import { Instance, type InstanceContext } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import * as Fence from "./fence"
import { resolveWorkspaceRoute } from "./instance/workspace-routing"
import { ServerProxy } from "./proxy"
import {
  isGlobalSpecialRequest,
  isWorkspaceWebSocketSpecialRequest,
  type ProductionSpecialHandler,
} from "./production-special"
import { requestContextFromRequest, withRequestContext } from "./request-context"
import { ProductionApi } from "./production-api"
import { automationHandlers } from "./routes/instance/httpapi/handlers/automation"
import { configHandlers } from "./routes/instance/httpapi/handlers/config"
import { controlHandlers } from "./routes/instance/httpapi/handlers/control"
import { experimentalHandlers } from "./routes/instance/httpapi/handlers/experimental"
import { externalResultHandlers } from "./routes/instance/httpapi/handlers/external-result"
import { fileHandlers } from "./routes/instance/httpapi/handlers/file"
import { globalHandlers } from "./routes/instance/httpapi/handlers/global"
import { mcpHandlers } from "./routes/instance/httpapi/handlers/mcp"
import { memoryHandlers } from "./routes/instance/httpapi/handlers/memory"
import { permissionHandlers } from "./routes/instance/httpapi/handlers/permission"
import { projectHandlers } from "./routes/instance/httpapi/handlers/project"
import { providerHandlers } from "./routes/instance/httpapi/handlers/provider"
import { ptyHandlers } from "./routes/instance/httpapi/handlers/pty"
import { rootHandlers } from "./routes/instance/httpapi/handlers/root"
import { sessionHandlers } from "./routes/instance/httpapi/handlers/session"
import { workspaceHandlers } from "./routes/instance/httpapi/handlers/workspace"

const productionHandlers = Layer.mergeAll(
  controlHandlers,
  globalHandlers,
  workspaceHandlers,
  rootHandlers,
  projectHandlers,
  ptyHandlers,
  configHandlers,
  experimentalHandlers,
  sessionHandlers,
  permissionHandlers,
  externalResultHandlers,
  providerHandlers,
  memoryHandlers,
  automationHandlers,
  fileHandlers,
  mcpHandlers,
)

const productionRouterLayer = HttpApiBuilder.layer(ProductionApi).pipe(
  Layer.provide(productionHandlers),
  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodeHttpPlatform.layer, NodePath.layer, Etag.layer)),
)

const apiPrefixes = [
  "/auth/",
  "/global/",
  "/experimental/",
  "/session",
  "/permission",
  "/external-result",
  "/provider",
  "/memory",
  "/automation",
  "/mcp",
  "/project",
  "/pty",
  "/config",
  "/find",
  "/file",
]

const apiExactPaths = new Set([
  "/doc",
  "/log",
  "/instance/dispose",
  "/path",
  "/vcs",
  "/vcs/status",
  "/vcs/diff",
  "/vcs/diff/raw",
  "/vcs/apply",
  "/command",
  "/agent",
  "/skill",
  "/lsp",
])

function pathnameOf(request: Request) {
  return new URL(request.url).pathname
}

function isWebSocketUpgrade(request: Request) {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket"
}

export function isProductionHttpApiRequest(request: Request) {
  const pathname = pathnameOf(request)
  if (isGlobalSpecialRequest(request.method, pathname)) return true
  if (request.method === "GET" && pathname === "/event") return true
  if (isWorkspaceWebSocketSpecialRequest(request.method, pathname)) return true
  if (request.method === "GET" && /^\/pty\/[^/]+\/connect$/.test(pathname)) return true
  if (apiExactPaths.has(pathname)) return true
  return apiPrefixes.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix))
}

function isGlobalApi(pathname: string) {
  return pathname.startsWith("/global/")
}

function isWorkspaceApi(pathname: string) {
  return pathname === "/experimental/workspace" || pathname.startsWith("/experimental/workspace/")
}

function isControlPlaneApi(pathname: string) {
  return pathname === "/doc" || pathname === "/log" || pathname.startsWith("/auth/")
}

function isInstanceCompatibilityApi(pathname: string) {
  return pathname === "/event" || /^\/pty\/[^/]+\/connect$/.test(pathname)
}

function resolveDirectory(request: Request) {
  const url = new URL(request.url)
  const pawworkDefault = path.join(os.homedir(), "PawWork")
  const raw = url.searchParams.get("directory") || request.headers.get("x-opencode-directory") || pawworkDefault
  const directory = Filesystem.resolve(
    (() => {
      try {
        return decodeURIComponent(raw)
      } catch {
        return raw
      }
    })(),
  )

  if (!url.searchParams.has("directory") && !request.headers.has("x-opencode-directory")) {
    try {
      mkdirSync(pawworkDefault, { recursive: true })
    } catch {
      // Ignore: home may be unwritable or path may be a regular file.
    }
  }

  return directory
}

type EffectRequestRefs = {
  instance: InstanceContext
  workspaceID?: WorkspaceID
}

function effectRequestContext(refs?: EffectRequestRefs) {
  if (!refs) return undefined
  const context = Context.add(Context.empty(), InstanceRef, refs.instance)
  if (!refs.workspaceID) return context
  return Context.add(context, WorkspaceRef, refs.workspaceID)
}

function provideInstanceContext(input: {
  directory: string
  request: Request
  workspaceID?: WorkspaceID
  fn: (refs: EffectRequestRefs) => Promise<Response>
}) {
  const snapshot = requestContextFromRequest(input.request, {
    directory: input.directory,
    workspaceID: input.workspaceID,
  })

  const runInstance = () =>
    withRequestContext(snapshot, () =>
      Instance.provide({
        directory: input.directory,
        fn: () =>
          input.fn({
            instance: Instance.current,
            workspaceID: input.workspaceID,
          }),
      }),
    )

  if (!input.workspaceID) return runInstance()

  return WorkspaceContext.provide({
    workspaceID: input.workspaceID,
    fn: runInstance,
  })
}

async function runWithFence(request: Request, next: () => Promise<Response>) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return next()

  const prev = Fence.load()
  const response = await next()
  const current = Fence.diff(prev, Fence.load())
  if (Object.keys(current).length === 0) return response

  const headers = new Headers(response.headers)
  headers.set("x-opencode-sync", JSON.stringify(current))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

type ProductionHttpApiDispatcherOptions = {
  handler?: (request: Request) => Promise<Response>
  specialHandler?: ProductionSpecialHandler
}

function createProductionWebHandler() {
  const resolveSymbol = Symbol.for("@effect/platform/HttpApp/resolve")

  return {
    dispose: async () => {},
    async handler(request: Request, context?: Context.Context<never>) {
      const handler = (await AppRuntime.runPromise(
        Effect.scoped(HttpRouter.toHttpEffect(productionRouterLayer as never)) as never,
      )) as Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, HttpServerRequest.HttpServerRequest>
      const response = await new Promise<Response>((resolve) => {
        const httpServerRequest = HttpServerRequest.fromWeb(request)
        ;(httpServerRequest as any)[resolveSymbol] = resolve
        const requestContext = Context.add(context ?? Context.empty(), HttpServerRequest.HttpServerRequest, httpServerRequest)
        const responseHandler = HttpEffect.toHandled(handler, (request, response) => {
          response = HttpEffect.scopeTransferToStream(response)
          ;(request as any)[resolveSymbol](
            HttpServerResponse.toWeb(response, { withoutBody: request.method === "HEAD", context: requestContext }),
          )
          return Effect.void
        })
        const instance = context ? Context.getReferenceUnsafe(context, InstanceRef) : undefined
        const workspaceID = context ? Context.getReferenceUnsafe(context, WorkspaceRef) : undefined
        let effect = responseHandler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, httpServerRequest))
        if (instance) effect = effect.pipe(Effect.provideService(InstanceRef, instance))
        if (workspaceID) effect = effect.pipe(Effect.provideService(WorkspaceRef, workspaceID))
        const fiber = AppRuntime.runFork(effect as never)
        request.signal?.addEventListener(
          "abort",
          () => {
            fiber.interruptUnsafe(undefined as never)
          },
          { once: true },
        )
      })
      return response
    },
  }
}

export function createProductionHttpApiDispatcher(
  upgradeWebSocket: UpgradeWebSocket,
  options: ProductionHttpApiDispatcherOptions = {},
) {
  const web = options.handler
    ? {
        handler: options.handler,
        dispose: async () => {},
      }
    : createProductionWebHandler()

  const dispatchLocal = (request: Request, refs?: EffectRequestRefs) => {
    const context = effectRequestContext(refs)
    if (!context) return web.handler(request)
    return web.handler(request, context as never)
  }
  const dispatchInstance = (request: Request, env: unknown) =>
    runWithFence(request, async () => {
      const url = new URL(request.url)
      const directory = resolveDirectory(request)
      const workspaceID = url.searchParams.get("workspace") || request.headers.get("x-opencode-workspace")
      const resolution = await AppRuntime.runPromise(
        resolveWorkspaceRoute({
          method: request.method,
          pathname: url.pathname,
          directory,
          workspaceID,
          ensureConfig: url.searchParams.get("ensureConfig") === "true",
          isPawWork: Runtime.isPawWork(),
          isWebSocketUpgrade: isWebSocketUpgrade(request),
        }),
      )

      if (resolution.action === "provide-local-context") {
        if (resolution.createLegacyConfig) mkdirSync(Global.Path.config, { recursive: true })
        return provideInstanceContext({
          directory: resolution.directory,
          workspaceID: resolution.workspaceID,
          request,
          fn: async (refs) => {
            if (isInstanceCompatibilityApi(url.pathname)) {
              const response = await options.specialHandler?.handleInstance(request, env)
              if (response) return response
            }
            return dispatchLocal(request, refs)
          },
        })
      }

      if (resolution.action === "serve-local-cache" || resolution.action === "pass-missing-session-delete") {
        return dispatchLocal(request)
      }

      if (resolution.action === "missing-workspace-error") {
        return new Response(`Workspace not found: ${resolution.workspaceID}`, {
          status: 500,
          headers: {
            "content-type": "text/plain; charset=utf-8",
          },
        })
      }

      if (resolution.action === "proxy-websocket") {
        return ServerProxy.websocket(upgradeWebSocket, resolution.target, request, env)
      }

      const headers = new Headers(request.headers)
      headers.delete("x-opencode-workspace")
      return ServerProxy.http(
        resolution.target.url,
        resolution.target.headers,
        new Request(request, {
          headers,
        }),
        resolution.workspaceID,
      )
    })

  return {
    async handle(request: Request, env?: unknown) {
      const pathname = pathnameOf(request)
      if (isGlobalSpecialRequest(request.method, pathname) || isWorkspaceWebSocketSpecialRequest(request.method, pathname)) {
        const response = await options.specialHandler?.handle(request, env)
        if (response) return response
      }
      if (isControlPlaneApi(pathname)) return dispatchLocal(request)
      if (isGlobalApi(pathname)) {
        const snapshot = requestContextFromRequest(request, {})
        return withRequestContext(snapshot, () => dispatchLocal(request))
      }
      if (isWorkspaceApi(pathname)) {
        const directory = resolveDirectory(request)
        return provideInstanceContext({
          directory,
          request,
          fn: (refs) => dispatchLocal(request, refs),
        })
      }
      return dispatchInstance(request, env)
    },
    dispose: web.dispose,
  }
}
