window.__ModuleLoader__.load({
  id: "@pawwork/dsh-mcp-oauth",
  factory: (require) => {
    const { createElement: h, useCallback, useEffect, useState } = require("react")
    const { Button, IconPlusOutline16, Modal, Tag } = require("@deepseek-ai/dsh-client-ui-primitives")

    const CHANNEL = "/pawwork-mcp-oauth"
    // Geometry and tokens follow the DSH Models settings page, which is the
    // closest official page (a list of configured entries plus an editor card).
    const css = `
.pawwork-mcp-surface { color: var(--dsw-alias-label-primary); display: flex; flex-direction: column; gap: 12px; max-width: 720px; min-width: 0; }
.pawwork-mcp-title { font-size: 16px; font-weight: 500; line-height: 24px; margin: 0; }
.pawwork-mcp-intro { color: var(--dsw-alias-label-tertiary); font-size: 14px; line-height: 22px; margin: 0; }
.pawwork-mcp-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; margin: 0; overflow-wrap: anywhere; }
.pawwork-mcp-note { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; margin: 0; }
.pawwork-mcp-note a { color: var(--dsw-alias-label-secondary); }
.pawwork-mcp-rows { display: flex; flex-direction: column; gap: 8px; list-style: none; margin: 0; padding: 0; }
.pawwork-mcp-row { border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 16px; display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; }
.pawwork-mcp-row-head { align-items: center; display: flex; gap: 10px; }
.pawwork-mcp-identity { align-items: center; display: inline-flex; gap: 8px; min-width: 0; }
.pawwork-mcp-name { font-size: 14px; font-weight: 500; line-height: 22px; }
.pawwork-mcp-actions { align-items: center; display: inline-flex; flex: none; gap: 4px; margin-left: auto; }
.pawwork-mcp-url { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pawwork-mcp-danger { color: var(--dsw-alias-state-error-primary); }
.pawwork-mcp-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.pawwork-mcp-empty { border: 1px dashed var(--dsw-alias-border-l3); border-radius: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; padding: 12px; text-align: center; }
.pawwork-mcp-add { display: flex; flex-direction: column; gap: 12px; }
.pawwork-mcp-add-button { align-items: center; background: none; border: 1px dashed var(--dsw-alias-border-l3); border-radius: 16px; box-sizing: border-box; color: var(--dsw-alias-label-primary); cursor: pointer; display: inline-flex; font: inherit; font-size: 14px; gap: 6px; height: 44px; justify-content: center; line-height: 22px; padding: 0 14px; }
.pawwork-mcp-add-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.pawwork-mcp-add-button:disabled { cursor: default; opacity: 0.4; }
.pawwork-mcp-add-button:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); outline: none; }
.pawwork-mcp-card { background: var(--dsw-alias-bg-module-platform); border-radius: 12px; display: flex; flex-direction: column; gap: 14px; padding: 14px 16px; }
.pawwork-mcp-card-title { font-size: 14px; font-weight: 500; line-height: 22px; }
.pawwork-mcp-field { display: flex; flex-direction: column; gap: 6px; }
.pawwork-mcp-label { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
.pawwork-mcp-input { background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; box-sizing: border-box; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; height: 32px; line-height: 22px; padding: 0 10px; width: 100%; }
.pawwork-mcp-input:focus { border-color: var(--dsw-alias-brand-primary); outline: none; }
.pawwork-mcp-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.pawwork-mcp-input:disabled { cursor: default; opacity: 0.6; }
textarea.pawwork-mcp-input { font-family: var(--ds-font-family-code, monospace); font-size: 13px; height: auto; line-height: 20px; min-height: 64px; padding: 6px 10px; resize: vertical; }
.pawwork-mcp-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; margin: 0; }
.pawwork-mcp-card-actions { display: flex; gap: 8px; justify-content: flex-end; }
.pawwork-mcp-dialog { width: min(480px, 100%); }
.pawwork-mcp-dialog-body { color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px; margin: 0; overflow-wrap: anywhere; }
.pawwork-mcp-dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }
`
    let styled = false
    function ensureStyle() {
      if (styled) return
      styled = true
      const style = document.createElement("style")
      style.textContent = css
      document.head.appendChild(style)
    }
    function isChinese() { return document.documentElement.lang.startsWith("zh") }
    function text(chinese, english) { return isChinese() ? chinese : english }
    const STATE = {
      unauthorized: { tone: "warning", label: () => text("未授权", "Not authorized") },
      connecting: { tone: "info", label: () => text("连接中", "Connecting") },
      connected: { tone: "success", label: () => text("已连接", "Connected") },
      expired: { tone: "warning", label: () => text("授权过期", "Authorization expired") },
      disconnected: { tone: "danger", label: () => text("连接失败", "Connection failed") },
    }
    const PENDING = { tone: "info", label: () => text("等待授权", "Waiting for authorization") }
    // The callback server reports its outcome as an English slug; translate the
    // known ones and pass anything else through untouched.
    const ERROR_LABEL = {
      timeout: () => text("等待授权超时", "Timed out waiting for authorization"),
      access_denied: () => text("授权被拒绝", "Authorization was denied"),
      authorization_failed: () => text("授权未完成", "Authorization did not complete"),
      missing_code: () => text("回调没有携带授权码", "The callback carried no authorization code"),
      closed: () => text("授权已取消", "Authorization was cancelled"),
    }
    const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

    function describeFailure(failure) {
      const message = String(failure?.message ?? failure).replace(/^mcp-oauth:\s*/, "")
      if (/ is already configured$/.test(message)) return text("已有同名的服务器。", "A server with that name is already configured.")
      if (/^engine is disposed$/.test(message)) return text("爪印正在关闭，请稍后再试。", "PawWork is shutting down; try again later.")
      return message
    }

    function call(connection, endpoint, payload = {}, signal) {
      return connection.rpc.call(CHANNEL, endpoint, payload, signal).then((result) => {
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      })
    }

    function parseHeaders(value) {
      const headers = Object.create(null)
      for (const line of String(value).split("\n")) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        const at = trimmed.indexOf(":")
        if (at <= 0) throw new Error(text("自定义请求头每行写成「名称: 值」。", "Write each custom header as Name: Value on its own line."))
        headers[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
      }
      return headers
    }

    // Mirrors the engine's acceptance rules so the user reads the refusal in
    // their language before the request leaves the renderer.
    function validateDraft(draft) {
      const serverName = draft.serverName.trim()
      if (!SERVER_NAME.test(serverName)) return text("名称只能用字母、数字、_ 和 -，最长 32 个字符。", "The name may use letters, digits, _ and -, up to 32 characters.")
      let url
      try { url = new URL(draft.url.trim()) } catch { return text("服务器地址不是有效的网址。", "The server URL is not a valid URL.") }
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return text("服务器地址需要以 https:// 开头（仅本机地址可用 http://）。", "The server URL must start with https:// (http:// is allowed only for localhost).")
      if (url.username !== "" || url.password !== "") return text("服务器地址里不能带用户名或密码。", "The server URL must not embed a username or password.")
      return null
    }

    function field(label, control) {
      return h("div", { className: "pawwork-mcp-field" }, h("span", { className: "pawwork-mcp-label" }, label), control)
    }

    function AddCard({ busy, onCancel, onSubmit }) {
      const [draft, setDraft] = useState({ serverName: "", url: "", headers: "" })
      const [error, setError] = useState(null)
      const update = (key) => (event) => setDraft({ ...draft, [key]: event.target.value })
      const submit = () => {
        const problem = validateDraft(draft)
        if (problem !== null) { setError(problem); return }
        let headers
        try { headers = parseHeaders(draft.headers) } catch (failure) { setError(failure.message); return }
        setError(null)
        onSubmit({ serverName: draft.serverName.trim(), url: draft.url.trim(), headers })
      }
      const canSubmit = draft.serverName.trim() !== "" && draft.url.trim() !== "" && !busy
      return h("div", { className: "pawwork-mcp-card" },
        h("span", { className: "pawwork-mcp-card-title" }, text("添加远程 MCP 服务器", "Add a remote MCP server")),
        field(text("名称", "Name"), h("input", { className: "pawwork-mcp-input", "aria-label": text("名称", "Name"), autoFocus: true, disabled: busy, onChange: update("serverName"), placeholder: "linear", type: "text", value: draft.serverName })),
        field(text("服务器地址", "Server URL"), h("input", { className: "pawwork-mcp-input", "aria-label": text("服务器地址", "Server URL"), disabled: busy, onChange: update("url"), placeholder: "https://mcp.example.com/mcp", type: "text", value: draft.url })),
        field(text("自定义请求头（可选）", "Custom headers (optional)"), h("textarea", { className: "pawwork-mcp-input", "aria-label": text("自定义请求头", "Custom headers"), disabled: busy, onChange: update("headers"), placeholder: "X-Api-Version: 2", value: draft.headers })),
        error === null
          ? h("p", { className: "pawwork-mcp-hint" }, text("每行一个请求头，写成「名称: 值」。", "One header per line, written as Name: Value."))
          : h("p", { className: "pawwork-mcp-error", role: "alert" }, error),
        h("div", { className: "pawwork-mcp-card-actions" },
          h(Button, { disabled: busy, onClick: onCancel, type: "button", variant: "outline" }, text("取消", "Cancel")),
          h(Button, { disabled: !canSubmit, onClick: submit, type: "button", variant: "primary" }, text("添加", "Add"))))
    }

    function Surface({ connection }) {
      ensureStyle()
      const [status, setStatus] = useState({ servers: null, fileError: null, error: null })
      const { servers } = status
      const applyStatus = (value) => setStatus({ servers: value.servers, fileError: value.fileError ?? null, error: null })
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState("")
      const [adding, setAdding] = useState(false)
      const [removing, setRemoving] = useState(null)
      // Kept so a browser that never opened (or was closed) can be retried;
      // a repeated authorize reuses the pending attempt and returns this URL.
      const [pendingUrl, setPendingUrl] = useState("")

      const refresh = useCallback(async () => {
        try {
          const next = await call(connection, "status")
          applyStatus(next)
          return next.servers
        } catch (failure) {
          setStatus((previous) => ({ ...previous, error: describeFailure(failure) }))
          return null
        }
      }, [connection])

      // Background refresh and reconnect can change status without a UI action.
      useEffect(() => {
        void refresh()
        const timer = setInterval(() => void refresh(), 1500)
        return () => clearInterval(timer)
      }, [refresh])

      const run = async (serverName, endpoint, payload) => {
        setBusy(serverName)
        setError(null)
        try {
          return await call(connection, endpoint, payload)
        } catch (failure) {
          setError(describeFailure(failure))
          return null
        } finally {
          setBusy("")
        }
      }

      const authorize = async (serverName) => {
        const answer = await run(serverName, "authorize", { serverName })
        if (answer === null) return
        if (typeof answer.authorizationUrl === "string" && answer.authorizationUrl.length > 0) {
          setPendingUrl(answer.authorizationUrl)
          window.open(answer.authorizationUrl, "_blank", "noopener")
        }
        await refresh()
      }

      const signOut = async (serverName) => {
        const answer = await run(serverName, "signOut", { serverName })
        if (answer !== null) applyStatus(answer)
      }

      const retry = async (serverName) => {
        const answer = await run(serverName, "retry", { serverName })
        if (answer !== null) applyStatus(answer)
      }

      const remove = async (serverName) => {
        const answer = await run(serverName, "remove", { serverName })
        setRemoving(null)
        if (answer !== null) applyStatus(answer)
      }

      const add = async (entry) => {
        const answer = await run("add", "add", entry)
        if (answer === null) return
        applyStatus(answer)
        setAdding(false)
      }

      const disabled = busy !== ""

      function actionsFor(server) {
        const name = server.serverName
        const button = (key, variant, label, onClick, extra = {}) =>
          h(Button, { disabled, key, onClick, size: "sm", type: "button", variant, ...extra }, label)
        const signOutButton = button("signout", "ghost", server.authorizationPending ? text("取消授权", "Cancel authorization") : text("退出登录", "Sign out"), () => void signOut(name))
        const removeButton = button("remove", "ghost", text("移除", "Remove"), () => setRemoving(name), { className: "pawwork-mcp-danger" })
        if (server.authorizationPending) return [signOutButton, removeButton]
        if (server.state === "connecting") return [removeButton]
        // A startup load reports connected even while the bridge is still
        // retrying in the background, so Retry stays available here — it
        // reconnects without touching the grant.
        if (server.state === "connected") return [button("retry", "ghost", text("重连", "Retry"), () => void retry(name)), signOutButton, removeButton]
        if (server.state === "disconnected") return [button("retry", "outline", text("重连", "Retry"), () => void retry(name)), signOutButton, removeButton]
        // unauthorized | expired — authorizing never destroys a grant that
        // still works; switching accounts goes through Sign out.
        return [
          button("auth", "primary", server.state === "expired" ? text("重新授权", "Reauthorize") : text("授权", "Authorize"), () => void authorize(name)),
          server.state === "expired" ? signOutButton : null,
          removeButton,
        ]
      }

      function row(server) {
        const state = server.authorizationPending ? PENDING : (STATE[server.state] ?? { tone: "neutral", label: () => server.state })
        return h("li", { className: "pawwork-mcp-row", key: server.serverName },
          h("div", { className: "pawwork-mcp-row-head" },
            h("span", { className: "pawwork-mcp-identity" },
              h("span", { className: "pawwork-mcp-name" }, server.serverName),
              h(Tag, { tone: state.tone }, state.label())),
            h("span", { className: "pawwork-mcp-actions" }, actionsFor(server))),
          h("span", { className: "pawwork-mcp-url", title: server.url }, server.url),
          server.lastError ? h("p", { className: "pawwork-mcp-error" }, ERROR_LABEL[server.lastError]?.() ?? describeFailure(server.lastError)) : null,
          server.authorizationPending ? h("p", { className: "pawwork-mcp-note" },
            text("已在浏览器打开授权页面，完成后这里会自动更新。", "The authorization page is open in your browser; this list updates when it is done."),
            pendingUrl !== "" ? [" ", h("a", { href: pendingUrl, key: "reopen", rel: "noopener", target: "_blank" }, text("重新打开授权页", "Open it again"))] : null) : null)
      }

      const removingServer = servers?.find((server) => server.serverName === removing)

      return h("div", { className: "pawwork-mcp-surface" },
        h("h2", { className: "pawwork-mcp-title" }, text("集成", "Integrations")),
        h("p", { className: "pawwork-mcp-intro" }, text("需要登录的远程 MCP 服务器。点「授权」会打开系统浏览器，登录后回到这里即可在会话中使用它的工具。", "Remote MCP servers that need a login. Authorize opens your browser; once you are back, the server's tools are available in sessions.")),
        error !== null || status.error !== null ? h("p", { className: "pawwork-mcp-error", role: "alert" }, error ?? status.error) : null,
        status.fileError !== null ? h("p", { className: "pawwork-mcp-error", role: "alert" }, text("服务器列表文件无法读取，为避免覆盖已拒绝改动：", "The server list file could not be read; changes are refused rather than overwriting it: ") + status.fileError) : null,
        servers === null
          ? (status.error === null ? h("p", { className: "pawwork-mcp-note" }, text("正在加载…", "Loading…")) : null)
          : servers.length === 0
            ? h("div", { className: "pawwork-mcp-empty" }, text("还没有远程 MCP 服务器。", "No remote MCP servers yet."))
            : h("ul", { className: "pawwork-mcp-rows" }, servers.map(row)),
        h("div", { className: "pawwork-mcp-add" },
          adding
            ? h(AddCard, { busy: busy === "add", onCancel: () => setAdding(false), onSubmit: (entry) => void add(entry) })
            : h("button", { className: "pawwork-mcp-add-button", disabled: servers === null || status.fileError !== null, onClick: () => { setError(null); setAdding(true) }, type: "button" },
                h(IconPlusOutline16, { size: 14 }), text("添加远程 MCP 服务器", "Add a remote MCP server"))),
        h(Modal, {
          className: "pawwork-mcp-dialog",
          closeLabel: text("关闭", "Close"),
          onClose: () => setRemoving(null),
          open: removingServer !== undefined,
          title: text("移除 " + (removing ?? "") + "？", "Remove " + (removing ?? "") + "?"),
          footer: h("div", { className: "pawwork-mcp-dialog-actions" },
            h(Button, { disabled, onClick: () => setRemoving(null), type: "button", variant: "outline" }, text("取消", "Cancel")),
            h(Button, { className: "pawwork-mcp-danger", disabled, onClick: () => void remove(removing), type: "button", variant: "outline" }, text("移除", "Remove"))),
        }, h("p", { className: "pawwork-mcp-dialog-body" },
          removingServer?.state === "connected" || removingServer?.state === "expired"
            ? text("会同时删除已保存的登录授权，会话将无法再使用它的工具。", "Its saved authorization is deleted too, and sessions lose access to its tools.")
            : text("会话将无法再使用它的工具。", "Sessions lose access to its tools."))))
    }

    const inject = ["slots", "connection"]

    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "pawwork-mcp-oauth",
        order: 45,
        label: () => text("集成", "Integrations"),
      }, (props) => h(Surface, { ...props, connection: ctx.connection })))
    }

    return { inject, apply }
  },
})
