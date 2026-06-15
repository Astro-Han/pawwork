import "@/index.css"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router, useLocation } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { type Duration, Effect } from "effect"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { GlobalSyncProvider, useGlobalSync } from "@/context/global-sync"
import { ConnectionHealthProvider } from "@/context/connection-health"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider, useLayout } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import { AppStartupPending } from "@/components/app-startup-pending"
import { AboutModal } from "@/components/about-modal"
import type {
  AboutInfo,
  RemoteAccessConfig,
  RemoteAccessStatus,
  RendererDiagnosticInput,
  RendererDiagnosticsExportResult,
  WebSearchStatus,
} from "@/desktop-api-contract"
import DirectoryLayout from "@/pages/directory-layout"
import Layout from "@/pages/layout"
import AutomationsRoute from "@/pages/automations/automations-route"
import SettingsRoute from "@/pages/settings/settings-route"
import SkillsRoute from "@/pages/skills/skills-route"
import { ErrorPage } from "./pages/error"
import { buildDesktopContext, desktopWindowTitle, type DesktopContext } from "./utils/desktop-context"
import { useCheckServerHealth } from "./utils/server-health"
import { base64Encode } from "@opencode-ai/util/encode"

const loadSession = () => import("@/pages/session")
const Session = lazy(loadSession)
const Loading = () => <AppStartupPending />

if (typeof location === "object" && /\/session(?:\/|$)/.test(location.pathname)) {
  void loadSession()
}

const SessionRoute = () => (
  <SessionProviders>
    <Session />
  </SessionProviders>
)

const SessionIndexRoute = () => <Navigate href="session" />

const HomeRedirectRoute = () => {
  const layout = useLayout()
  const sync = useGlobalSync()
  const target = createMemo(() => {
    const local = layout.projects.list()[0]?.worktree
    if (local) return local
    if (!sync.ready) return undefined
    return sync.data.project[0]?.worktree
  })
  return (
    <Show
      when={target()}
      fallback={<AppStartupPending />}
    >
      {(directory) => <Navigate href={`/${base64Encode(directory())}/session`} />}
    </Show>
  )
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
    }
    api?: {
      setDesktopContext?: (context: DesktopContext) => Promise<void>
      emitRendererDiagnostic?: (event: RendererDiagnosticInput) => Promise<void>
      exportDiagnosticsLog?: () => Promise<RendererDiagnosticsExportResult>
      getAboutInfo?: () => Promise<AboutInfo>
      onAboutOpen?: (handler: () => void) => () => void
      setLspEnabled?: (value: boolean) => Promise<void>
      setWebSearchEnabled?: (value: boolean) => Promise<void>
      webSearchStatus?: () => Promise<WebSearchStatus>
      saveExaApiKey?: (key: string) => Promise<WebSearchStatus>
      removeExaApiKey?: () => Promise<WebSearchStatus>
      remoteAccessConfig?: () => Promise<RemoteAccessConfig>
      remoteAccessSaveConfig?: (config: RemoteAccessConfig) => Promise<RemoteAccessConfig>
      remoteAccessStatus?: () => Promise<RemoteAccessStatus>
      remoteAccessStart?: (config?: RemoteAccessConfig) => Promise<RemoteAccessStatus>
      remoteAccessStop?: () => Promise<RemoteAccessStatus>
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient()
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function AppShellProviders(props: ParentProps) {
  return (
    <SettingsProvider>
      <PermissionProvider>
        <LayoutProvider>
          <NotificationProvider>
            <ModelsProvider>
              <CommandProvider>
                <HighlightsProvider>
                  <ConnectionHealthProvider>
                    {/* Terminal runtimes (PTY handles) must outlive the session
                        route: leaving a session and coming back has to reattach
                        to the same server-side PTY instead of orphaning it and
                        spawning a fresh shell. The provider is route-aware via
                        useParams but holds its per-workspace cache here, above
                        any route swap. */}
                    <TerminalProvider>
                      <Layout>{props.children}</Layout>
                    </TerminalProvider>
                  </ConnectionHealthProvider>
                </HighlightsProvider>
              </CommandProvider>
            </ModelsProvider>
          </NotificationProvider>
        </LayoutProvider>
      </PermissionProvider>
    </SettingsProvider>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <FileProvider>
      <PromptProvider>
        <CommentsProvider>{props.children}</CommentsProvider>
      </PromptProvider>
    </FileProvider>
  )
}

function RouterRoot(props: ParentProps<{ appChildren?: JSX.Element }>) {
  return (
    <AppShellProviders>
      <Suspense fallback={<Loading />}>
        <DesktopContextRouteBridge />
        {props.appChildren}
        {props.children}
      </Suspense>
    </AppShellProviders>
  )
}

function DesktopContextRouteBridge() {
  const language = useLanguage()
  const location = useLocation()
  const desktopContextMaxRetries = 5
  let lastDesktopContext = ""
  let pendingDesktopContext = ""
  let desktopContextRetryTimer: number | undefined
  let desktopContextRetryCount = 0
  let disposed = false

  const clearDesktopContextRetry = () => {
    if (desktopContextRetryTimer !== undefined) window.clearTimeout(desktopContextRetryTimer)
    desktopContextRetryTimer = undefined
  }

  const syncDesktopContext = (context: DesktopContext, serialized: string) => {
    if (disposed || isSessionRoute(location.pathname)) return
    const setDesktopContext = window.api?.setDesktopContext
    if (!setDesktopContext) return
    void setDesktopContext(context)
      .then(() => {
        if (disposed || pendingDesktopContext !== serialized) return
        lastDesktopContext = serialized
        pendingDesktopContext = ""
        desktopContextRetryCount = 0
        clearDesktopContextRetry()
      })
      .catch(() => {
        if (disposed || pendingDesktopContext !== serialized || lastDesktopContext === serialized) return
        if (desktopContextRetryCount >= desktopContextMaxRetries) {
          pendingDesktopContext = ""
          desktopContextRetryCount = 0
          return
        }
        clearDesktopContextRetry()
        desktopContextRetryCount += 1
        const retryDelay = Math.min(4000, 250 * 2 ** (desktopContextRetryCount - 1))
        desktopContextRetryTimer = window.setTimeout(() => {
          desktopContextRetryTimer = undefined
          if (disposed || pendingDesktopContext !== serialized || lastDesktopContext === serialized) return
          syncDesktopContext(context, serialized)
        }, retryDelay)
      })
  }

  createEffect(() => {
    if (typeof document !== "object") return
    const pathname = location.pathname
    if (isSessionRoute(pathname)) return
    document.title = desktopWindowTitle(language.locale())
  })

  createEffect(() => {
    if (!window.api?.setDesktopContext) return
    if (isSessionRoute(location.pathname)) {
      pendingDesktopContext = ""
      desktopContextRetryCount = 0
      clearDesktopContextRetry()
      return
    }
    const context = buildDesktopContext({
      route: `${location.pathname}${location.search}${location.hash}`,
      locale: language.locale(),
    })
    const serialized = JSON.stringify(context)
    if (serialized === lastDesktopContext || serialized === pendingDesktopContext) return
    pendingDesktopContext = serialized
    desktopContextRetryCount = 0
    syncDesktopContext(context, serialized)
  })

  onCleanup(() => {
    disposed = true
    clearDesktopContextRetry()
  })

  return null
}

function isSessionRoute(pathname: string) {
  return /^\/[^/]+\/session(?:\/[^/]+)?\/?$/.test(pathname)
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        defaultTheme="pawwork"
        storageKeys={{
          themeId: "pawwork-theme-id",
          colorScheme: "pawwork-color-scheme",
          cssLight: "pawwork-theme-css-light",
          cssDark: "pawwork-theme-css-dark",
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <QueryProvider>
                <DialogProvider>
                  <MarkedProvider>
                    <FileComponentProvider component={File}>
                      <AboutModal />
                      {props.children}
                    </FileComponentProvider>
                  </MarkedProvider>
                </DialogProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

const effectMinDuration =
  (duration: Duration.Input) =>
  <A, E, R>(e: Effect.Effect<A, E, R>) =>
    Effect.all([e, Effect.sleep(duration)], { concurrency: "unbounded" }).pipe(Effect.map((v) => v[0]))

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    props.disableHealthCheck
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )

  return (
    <Show
      when={checkMode() === "blocking" ? !startupHealthCheck.loading : startupHealthCheck.state !== "pending"}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-bg-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      <Show
        when={startupHealthCheck()}
        fallback={
          <ConnectionError
            onRetry={() => {
              if (checkMode() === "background") healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              healthCheckActions.refetch()
            }}
          />
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-bg-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-body text-fg-base">
          {unreachable()[0]}
          <span class="text-fg-strong font-emphasis">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-body text-fg-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-body text-fg-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-body text-fg-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
}) {
  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      disableHealthCheck={props.disableHealthCheck}
      servers={props.servers}
    >
      <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
        <ServerKey>
          <GlobalSDKProvider>
            <GlobalSyncProvider>
              <Dynamic
                component={props.router ?? Router}
                root={(routerProps) => <RouterRoot appChildren={props.children}>{routerProps.children}</RouterRoot>}
              >
                <Route path="/" component={HomeRedirectRoute} />
                {/* Global surface routes: siblings of the session routes, not
                    nested under /:dir. Static segments outrank the /:dir
                    param, so these never resolve as a directory slug. */}
                <Route path="/settings" component={SettingsRoute} />
                <Route path="/automations" component={AutomationsRoute} />
                <Route path="/skills" component={SkillsRoute} />
                <Route path="/:dir" component={DirectoryLayout}>
                  <Route path="/" component={SessionIndexRoute} />
                  <Route path="/session/:id?" component={SessionRoute} />
                </Route>
              </Dynamic>
            </GlobalSyncProvider>
          </GlobalSDKProvider>
        </ServerKey>
      </ConnectionGate>
    </ServerProvider>
  )
}
