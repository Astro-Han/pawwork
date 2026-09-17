window.__ModuleLoader__.load({
  id: "@pawwork/dsh-mcp-oauth",
  factory: (require) => {
    const { createElement: h, Fragment, useCallback, useEffect, useState } = require("react")
    const { Button, IconPlusOutline16, Modal, Tag } = require("@deepseek-ai/dsh-client-ui-primitives")

    const CHANNEL = "/pawwork-mcp-oauth"
    const PLUGIN = "@pawwork/dsh-mcp-oauth"
    const css = `
.pawwork-mcp-surface { color: var(--dsw-alias-label-primary); display: flex; flex-direction: column; gap: 12px; max-width: 720px; min-width: 0; }
.pawwork-mcp-title { font-size: 16px; font-weight: 500; line-height: 24px; margin: 0; }
.pawwork-mcp-intro { color: var(--dsw-alias-label-tertiary); font-size: 14px; line-height: 22px; margin: 0; }
.pawwork-mcp-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; margin: 0; overflow-wrap: anywhere; }
.pawwork-mcp-note { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; margin: 0; }
.pawwork-mcp-rows { display: flex; flex-direction: column; gap: 8px; list-style: none; margin: 0; padding: 0; }
.pawwork-mcp-row { border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 16px; display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; }
.pawwork-mcp-row-head { align-items: center; display: flex; gap: 10px; }
.pawwork-mcp-identity { align-items: center; display: inline-flex; gap: 8px; min-width: 0; }
.pawwork-mcp-name, .pawwork-mcp-card-title { font-size: 14px; font-weight: 500; line-height: 22px; }
.pawwork-mcp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pawwork-mcp-tag { flex: none; }
.pawwork-mcp-actions { align-items: center; display: inline-flex; flex: none; gap: 4px; margin-left: auto; }
.pawwork-mcp-url { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pawwork-mcp-danger:not(:disabled) { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.pawwork-mcp-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.pawwork-mcp-link { background: none; border: none; border-radius: 6px; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 12px; line-height: 18px; margin-left: 2px; padding: 0 4px; }
.pawwork-mcp-link:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pawwork-mcp-empty { border: 1px dashed var(--dsw-alias-border-l3); border-radius: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; padding: 12px; text-align: center; }
.pawwork-mcp-add { display: flex; flex-direction: column; }
.pawwork-mcp-add-button { align-items: center; background: none; border: 1px dashed var(--dsw-alias-border-l3); border-radius: 16px; box-sizing: border-box; color: var(--dsw-alias-label-primary); cursor: pointer; display: inline-flex; font: inherit; font-size: 14px; gap: 6px; height: 44px; justify-content: center; line-height: 22px; padding: 0 14px; }
.pawwork-mcp-add-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.pawwork-mcp-add-button:disabled { cursor: default; opacity: 0.4; }
.pawwork-mcp-add-button:focus-visible, .pawwork-mcp-summary:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); outline: none; }
.pawwork-mcp-card { background: var(--dsw-alias-bg-module-platform); border-radius: 12px; display: flex; flex-direction: column; gap: 14px; padding: 14px 16px; }
.pawwork-mcp-field { display: flex; flex-direction: column; gap: 6px; }
.pawwork-mcp-label { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
.pawwork-mcp-input { background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; box-sizing: border-box; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; height: 32px; line-height: 22px; padding: 0 10px; width: 100%; }
.pawwork-mcp-input:focus { border-color: var(--dsw-alias-brand-primary); outline: none; }
.pawwork-mcp-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.pawwork-mcp-input:disabled { cursor: default; opacity: 0.6; }
textarea.pawwork-mcp-input { font-family: var(--ds-font-family-code, monospace); font-size: 13px; height: auto; line-height: 20px; min-height: 64px; padding: 6px 10px; resize: vertical; }
.pawwork-mcp-advanced { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 10px; }
.pawwork-mcp-summary { align-items: center; border-radius: 6px; color: var(--dsw-alias-label-secondary); cursor: pointer; display: flex; font-size: 12px; font-weight: 500; gap: 6px; line-height: 18px; list-style: none; margin-left: -4px; padding: 2px 4px; width: fit-content; }
.pawwork-mcp-summary::-webkit-details-marker { display: none; }
.pawwork-mcp-summary::before { border-bottom: 1.5px solid; border-right: 1.5px solid; content: ""; height: 5px; transform: rotate(-45deg) translate(-1px, -1px); transition: transform 0.12s; width: 5px; }
.pawwork-mcp-advanced[open] > .pawwork-mcp-summary::before { transform: rotate(45deg) translate(-1px, -1px); }
.pawwork-mcp-summary:hover { color: var(--dsw-alias-label-primary); }
.pawwork-mcp-advanced-body { display: flex; flex-direction: column; gap: 12px; padding-top: 12px; }
.pawwork-mcp-card-actions { display: flex; gap: 8px; justify-content: flex-end; }
.pawwork-mcp-dialog { width: min(480px, 100%); }
@media (prefers-reduced-motion: reduce) { .pawwork-mcp-summary::before { transition: none; } }
`
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(PLUGIN) + "]") === null) {
      const tag = document.createElement("style")
      tag.dataset.plugin = PLUGIN
      tag.dataset.pluginCss = PLUGIN
      tag.textContent = css
      document.head.appendChild(tag)
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
    // Engine and callback-server failures arrive as English text; the known
    // shapes are translated and the rest is shown behind a localized lead-in.
    const KNOWN_FAILURE = [
      [/^timeout$/, () => text("等待授权超时。", "Timed out waiting for authorization.")],
      [/^access_denied$/, () => text("授权被拒绝。", "Authorization was denied.")],
      [/^authorization_failed$/, () => text("授权未完成。", "Authorization did not complete.")],
      [/^missing_code$/, () => text("回调没有携带授权码。", "The callback carried no authorization code.")],
      [/^closed$/, () => text("授权已取消。", "Authorization was cancelled.")],
      [/ is already configured$/, () => text("已有同名的服务器。", "A server with that name is already configured.")],
      [/^no remote MCP server named /, () => text("这台服务器已不在列表里。", "That server is no longer in the list.")],
      [/^engine is disposed$/, () => text("爪印正在关闭，请稍后再试。", "PawWork is shutting down; try again later.")],
    ]
    function describeFailure(failure) {
      const message = String(failure?.message ?? failure).replace(/^(?:Error:\s*)?(?:mcp-oauth:\s*)?/, "")
      const known = KNOWN_FAILURE.find(([pattern]) => pattern.test(message))
      return known ? known[1]() : text("操作失败：", "The request failed: ") + message
    }

    function call(connection, endpoint, payload = {}) {
      return connection.rpc.call(CHANNEL, endpoint, payload).then((result) => {
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      })
    }

    // The same acceptance rules as server-list.js, checked here first so the
    // refusal reads in the user's language and lands next to the field.
    const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
    const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
    const HEADER_VALUE_BAD = /^[ \t]|[ \t]$|[^\t\x20-\x7e\x80-\xff]/
    function validateDraft(draft) {
      const problems = {}
      if (!SERVER_NAME.test(draft.serverName.trim())) {
        problems.serverName = text("名称是会话里引用这台服务器的代号，只能用字母、数字、_ 和 -，最长 32 个字符。", "The name is how sessions refer to this server: letters, digits, _ and -, up to 32 characters.")
      }
      let url = null
      try { url = new URL(draft.url.trim()) } catch { problems.url = text("服务器地址不是有效的网址。", "The server URL is not a valid URL.") }
      if (url !== null) {
        const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
        if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) problems.url = text("服务器地址需要以 https:// 开头（仅本机地址可用 http://）。", "The server URL must start with https:// (http:// is allowed only for localhost).")
        else if (url.username !== "" || url.password !== "") problems.url = text("服务器地址里不能带用户名或密码。", "The server URL must not embed a username or password.")
      }
      const headers = Object.create(null)
      for (const line of draft.headers.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        const at = trimmed.indexOf(":")
        const name = trimmed.slice(0, at).trim()
        const value = trimmed.slice(at + 1).trim()
        if (at <= 0 || !HEADER_NAME.test(name) || name.toLowerCase() === "__proto__") { problems.headers = text("每行写成「名称: 值」，名称只能用英文字母、数字和 - _ 等符号。", "Write each line as Name: Value; the name may use letters, digits and symbols such as - _."); break }
        if (HEADER_VALUE_BAD.test(value)) { problems.headers = text("请求头的值只能是英文字符，不能有中文或控制字符。", "Header values may contain only ASCII or Latin-1 characters."); break }
        headers[name] = value
      }
      return { problems, entry: { serverName: draft.serverName.trim(), url: draft.url.trim(), headers } }
    }

    function field(label, problem, control) {
      return h("div", { className: "pawwork-mcp-field" },
        h("span", { className: "pawwork-mcp-label" }, label),
        control,
        problem ? h("p", { className: "pawwork-mcp-error", role: "alert" }, problem) : null)
    }

    function AddCard({ busy, onCancel, onSubmit }) {
      const [draft, setDraft] = useState({ serverName: "", url: "", headers: "" })
      const [problems, setProblems] = useState({})
      const [failure, setFailure] = useState(null)
      const update = (key) => (event) => setDraft({ ...draft, [key]: event.target.value })
      const submit = async (event) => {
        event.preventDefault()
        const { problems: next, entry } = validateDraft(draft)
        setProblems(next)
        setFailure(null)
        if (Object.keys(next).length > 0) return
        setFailure(await onSubmit(entry))
      }
      const input = (key, label, extra) => h("input", {
        className: "pawwork-mcp-input", "aria-invalid": problems[key] !== undefined, "aria-label": label, disabled: busy,
        onChange: update(key), type: "text", value: draft[key], ...extra,
      })
      return h("form", { className: "pawwork-mcp-card", onSubmit: (event) => void submit(event) },
        h("span", { className: "pawwork-mcp-card-title" }, text("添加远程 MCP 服务器", "Add a remote MCP server")),
        field(text("名称", "Name"), problems.serverName, input("serverName", text("名称", "Name"), { autoFocus: true, placeholder: "linear" })),
        field(text("服务器地址", "Server URL"), problems.url, input("url", text("服务器地址", "Server URL"), { placeholder: "https://mcp.example.com/mcp" })),
        h("details", { className: "pawwork-mcp-advanced", open: draft.headers !== "" || problems.headers !== undefined },
          h("summary", { className: "pawwork-mcp-summary" }, text("自定义请求头", "Custom headers")),
          h("div", { className: "pawwork-mcp-advanced-body" },
            field(text("每行一个，写成「名称: 值」", "One per line, written as Name: Value"), problems.headers,
              h("textarea", { className: "pawwork-mcp-input", "aria-invalid": problems.headers !== undefined, "aria-label": text("自定义请求头", "Custom headers"), disabled: busy, onChange: update("headers"), placeholder: "X-Api-Version: 2", value: draft.headers })))),
        failure !== null ? h("p", { className: "pawwork-mcp-error", key: "failure", role: "alert" }, failure) : null,
        h("div", { className: "pawwork-mcp-card-actions" },
          h(Button, { disabled: busy, onClick: onCancel, type: "button", variant: "outline" }, text("取消", "Cancel")),
          h(Button, { disabled: busy || draft.serverName.trim() === "" || draft.url.trim() === "", type: "submit", variant: "primary" }, busy ? text("添加中…", "Adding…") : text("添加", "Add"))))
    }

    function Surface({ connection }) {
      const [status, setStatus] = useState({ servers: null, fileError: null, error: null })
      const { servers } = status
      const applyStatus = (value) => setStatus({ servers: value.servers, fileError: value.fileError ?? null, error: null })
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [adding, setAdding] = useState(false)
      const [removing, setRemoving] = useState(null)
      const [removeFailure, setRemoveFailure] = useState(null)

      const refresh = useCallback(async () => {
        try {
          applyStatus(await call(connection, "status"))
        } catch (failure) {
          setStatus((previous) => ({ ...previous, error: describeFailure(failure) }))
        }
      }, [connection])

      // Background refresh and reconnect can change status without a UI action.
      useEffect(() => {
        void refresh()
        const timer = setInterval(() => void refresh(), 1500)
        return () => clearInterval(timer)
      }, [refresh])

      // Resolves to the answer, or to null after reporting the failure through
      // `report`; one write at a time keeps the row buttons and the add form
      // from racing each other.
      const run = async (endpoint, payload, report = setError) => {
        setBusy(true)
        setError(null)
        try {
          return await call(connection, endpoint, payload)
        } catch (failure) {
          report(describeFailure(failure))
          return null
        } finally {
          setBusy(false)
        }
      }

      const mutate = async (endpoint, serverName) => {
        const answer = await run(endpoint, { serverName })
        if (answer !== null) applyStatus(answer)
      }

      // A repeated authorize while an attempt is pending answers with the same
      // page, so this also serves as "open the authorization page again".
      const authorize = async (serverName) => {
        const answer = await run("authorize", { serverName })
        if (answer === null) return
        if (answer.authorizationUrl) window.open(answer.authorizationUrl, "_blank", "noopener")
        await refresh()
      }

      const remove = async () => {
        const answer = await run("remove", { serverName: removing }, setRemoveFailure)
        if (answer === null) return
        setRemoving(null)
        applyStatus(answer)
      }

      const add = async (entry) => {
        let failure = null
        const answer = await run("add", entry, (message) => { failure = message })
        if (answer === null) return failure
        applyStatus(answer)
        setAdding(false)
        return null
      }

      const cannotWrite = status.fileError !== null

      function actionsFor(server) {
        const name = server.serverName
        const button = (key, variant, label, onClick, extra = {}) =>
          h(Button, { disabled: busy, key, onClick, size: "sm", type: "button", variant, ...extra }, label)
        const signOutButton = button("signout", "ghost", server.authorizationPending ? text("取消授权", "Cancel authorization") : text("退出登录", "Sign out"), () => void mutate("signOut", name))
        const removeButton = button("remove", "ghost", text("移除", "Remove"), () => { setRemoveFailure(null); setRemoving(name) }, { className: "pawwork-mcp-danger", disabled: busy || cannotWrite })
        if (server.authorizationPending) return [signOutButton, removeButton]
        if (server.state === "connecting") return [removeButton]
        // A startup load reports connected even while the bridge is still
        // retrying in the background, so Retry stays available here — it
        // reconnects without touching the grant.
        const lead = server.state === "connected" ? button("retry", "ghost", text("重连", "Retry"), () => void mutate("retry", name))
          : server.state === "disconnected" ? button("retry", "outline", text("重连", "Retry"), () => void mutate("retry", name))
          : button("auth", "primary", server.state === "expired" ? text("重新授权", "Reauthorize") : text("授权", "Authorize"), () => void authorize(name))
        return [lead, server.state === "unauthorized" ? null : signOutButton, removeButton]
      }

      function row(server) {
        const state = server.authorizationPending ? PENDING : (STATE[server.state] ?? { tone: "neutral", label: () => server.state })
        return h("li", { className: "pawwork-mcp-row", key: server.serverName },
          h("div", { className: "pawwork-mcp-row-head" },
            h("span", { className: "pawwork-mcp-identity" },
              h("span", { className: "pawwork-mcp-name", title: server.serverName }, server.serverName),
              h(Tag, { className: "pawwork-mcp-tag", tone: state.tone }, state.label())),
            h("span", { className: "pawwork-mcp-actions" }, actionsFor(server))),
          h("span", { className: "pawwork-mcp-url", title: server.url }, server.url),
          server.lastError ? h("p", { className: "pawwork-mcp-error", role: "status" }, describeFailure(server.lastError)) : null,
          server.authorizationPending ? h("p", { className: "pawwork-mcp-note" },
            text("已在浏览器打开授权页面，完成后这里会自动更新。", "The authorization page is open in your browser; this list updates when it is done."),
            h("button", { className: "pawwork-mcp-link", disabled: busy, onClick: () => void authorize(server.serverName), type: "button" }, text("重新打开授权页", "Open it again"))) : null)
      }

      return h("div", { className: "pawwork-mcp-surface" },
        h("h2", { className: "pawwork-mcp-title" }, text("集成", "Integrations")),
        h("p", { className: "pawwork-mcp-intro" }, text("需要登录的远程 MCP 服务器。点「授权」会打开系统浏览器，登录后回到这里即可在会话中使用它的工具。", "Remote MCP servers that need a login. Authorize opens your browser; once you are back, the server's tools are available in sessions.")),
        error !== null || status.error !== null ? h("p", { className: "pawwork-mcp-error", key: "error", role: "alert" }, error ?? status.error) : null,
        cannotWrite ? h("p", { className: "pawwork-mcp-error", key: "file", role: "alert" }, text("服务器列表文件无法读取，为避免覆盖已拒绝改动：", "The server list file could not be read; changes are refused rather than overwriting it: ") + status.fileError) : null,
        servers === null
          ? (status.error === null ? h("p", { className: "pawwork-mcp-note" }, text("正在加载…", "Loading…")) : null)
          : servers.length === 0
            ? h("div", { className: "pawwork-mcp-empty" }, text("还没有远程 MCP 服务器。", "No remote MCP servers yet."))
            : h("ul", { className: "pawwork-mcp-rows" }, servers.map(row)),
        h("div", { className: "pawwork-mcp-add" },
          adding
            ? h(AddCard, { busy, onCancel: () => setAdding(false), onSubmit: add })
            : h("button", { className: "pawwork-mcp-add-button", disabled: servers === null || cannotWrite, onClick: () => { setError(null); setAdding(true) }, type: "button" },
                h(IconPlusOutline16, { size: 14 }), text("添加远程 MCP 服务器", "Add a remote MCP server"))),
        h(Modal, {
          className: "pawwork-mcp-dialog",
          closeLabel: text("关闭", "Close"),
          description: text("已保存的登录授权会一起删除，会话将无法再使用它的工具。", "Its saved authorization is deleted too, and sessions lose access to its tools."),
          onClose: () => setRemoving(null),
          open: removing !== null,
          title: text("移除 " + (removing ?? "") + "？", "Remove " + (removing ?? "") + "?"),
          footer: h(Fragment, null,
            h(Button, { autoFocus: true, disabled: busy, onClick: () => setRemoving(null), type: "button", variant: "outline" }, text("取消", "Cancel")),
            h(Button, { className: "pawwork-mcp-danger", disabled: busy, onClick: () => void remove(), type: "button", variant: "outline" }, busy ? text("移除中…", "Removing…") : text("移除", "Remove"))),
        }, removeFailure !== null ? h("p", { className: "pawwork-mcp-error", role: "alert" }, removeFailure) : null))
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
