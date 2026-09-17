window.__ModuleLoader__.load({
  id: "@pawwork/dsh-mcp-oauth",
  factory: (require) => {
    const { createElement: h, useCallback, useEffect, useState } = require("react")
    const { Button, Input, Pill } = require("@deepseek-ai/dsh-client-ui-primitives")

    const CHANNEL = "/pawwork-mcp-oauth"
    const css = `
.pawwork-mcp-surface { color: var(--dsw-alias-label-primary); display: flex; flex-direction: column; gap: 12px; min-width: 0; width: 100%; }
.pawwork-mcp-head { display: flex; flex-direction: column; gap: 2px; padding: 2px 0 10px; }
.pawwork-mcp-head h2 { font-size: 18px; font-weight: 600; line-height: 26px; margin: 0; }
.pawwork-mcp-head p { color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xs-13); margin: 0; }
.pawwork-mcp-list { display: flex; flex-direction: column; gap: 8px; }
.pawwork-mcp-row { align-items: center; border: 1px solid var(--dsw-alias-border-l3); border-radius: 10px; display: flex; gap: 10px; padding: 10px 12px; }
.pawwork-mcp-identity { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.pawwork-mcp-name { font-weight: 600; }
.pawwork-mcp-url { color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xs-13); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pawwork-mcp-actions { display: flex; flex: none; gap: 6px; }
.pawwork-mcp-note { color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xs-13); }
.pawwork-mcp-error { color: var(--dsw-alias-label-error, #d33); font: var(--dsw-font-xs-13); }
.pawwork-mcp-add { border: 1px solid var(--dsw-alias-border-l3); border-radius: 10px; display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.pawwork-mcp-add-actions { display: flex; justify-content: flex-end; }
.pawwork-mcp-headers { box-sizing: border-box; width: 100%; min-height: 76px; resize: vertical; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; padding: 8px 10px; background: transparent; color: inherit; font: inherit; }
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
    const STATE_LABEL = {
      unauthorized: () => text("未授权", "Not authorized"),
      connected: () => text("已连接", "Connected"),
      expired: () => text("授权过期", "Authorization expired"),
      disconnected: () => text("连接失败", "Connection failed"),
    }

    function call(connection, endpoint, payload = {}, signal) {
      return connection.rpc.call(CHANNEL, endpoint, payload, signal).then((result) => {
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      })
    }

    function parseHeaders(value) {
      const headers = {}
      for (const line of String(value).split("\n")) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        const at = trimmed.indexOf(":")
        if (at <= 0) throw new Error(text("自定义请求头每行写成「名称: 值」", "Write each custom header as Name: Value on its own line"))
        headers[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
      }
      return headers
    }

    function row(server, actions) {
      return h("div", { className: "pawwork-mcp-row", key: server.serverName },
        h("div", { className: "pawwork-mcp-identity" },
          h("span", { className: "pawwork-mcp-name" }, server.serverName),
          h("span", { className: "pawwork-mcp-url", title: server.url }, server.url),
          server.lastError ? h("span", { className: "pawwork-mcp-error" }, server.lastError) : null),
        h(Pill, { active: server.state === "connected" }, STATE_LABEL[server.state]?.() ?? server.state),
        h("div", { className: "pawwork-mcp-actions" }, actions))
    }

    function Surface({ connection }) {
      ensureStyle()
      const [servers, setServers] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState("")
      const waiting = servers?.some((server) => server.authorizationPending) ?? false
      const [draft, setDraft] = useState({ serverName: "", url: "", headers: "" })

      const refresh = useCallback(async () => {
        try {
          const next = await call(connection, "status")
          setServers(next.servers)
          setError(null)
          return next.servers
        } catch (failure) {
          setError(String(failure?.message ?? failure))
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
          setError(String(failure?.message ?? failure))
          return null
        } finally {
          setBusy("")
        }
      }

      const authorize = async (serverName) => {
        const answer = await run(serverName, "authorize", { serverName })
        if (answer === null) return
        window.open(answer.authorizationUrl, "_blank", "noopener")
        await refresh()
      }

      const signOut = async (serverName) => {
        const answer = await run(serverName, "signOut", { serverName })
        if (answer !== null) setServers(answer.servers)
      }

      const remove = async (serverName) => {
        const answer = await run(serverName, "remove", { serverName })
        if (answer !== null) setServers(answer.servers)
      }

      const add = async () => {
        setBusy("add")
        setError(null)
        try {
          const answer = await call(connection, "add", {
            serverName: draft.serverName.trim(),
            url: draft.url.trim(),
            headers: parseHeaders(draft.headers),
          })
          setServers(answer.servers)
          setDraft({ serverName: "", url: "", headers: "" })
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy("")
        }
      }

      const canAdd = draft.serverName.trim() !== "" && draft.url.trim() !== "" && busy !== "add"

      return h("div", { className: "pawwork-mcp-surface" },
        h("div", { className: "pawwork-mcp-head" },
          h("h2", null, text("集成", "Integrations")),
          h("p", null, text("需要登录的远程 MCP 服务器：点「授权」会打开系统浏览器，登录后回到这里即可使用它的工具。自定义请求头照旧可用。", "Remote MCP servers that need a login: Authorize opens your browser, and its tools work here once you are back. Custom headers keep working."))),
        error !== null ? h("div", { className: "pawwork-mcp-error", role: "alert" }, error) : null,
        servers === null
          ? h("div", { className: "pawwork-mcp-note" }, text("正在加载…", "Loading…"))
          : servers.length === 0
            ? h("div", { className: "pawwork-mcp-note" }, text("还没有配置远程 MCP 服务器。", "No remote MCP servers configured yet."))
            : h("div", { className: "pawwork-mcp-list" }, servers.map((server) => row(server, [
                server.state === "connected"
                  ? h(Button, { disabled: busy !== "" || server.authorizationPending, key: "reauth", onClick: () => void authorize(server.serverName), size: "sm", type: "button", variant: "outline" }, text("重新授权", "Reauthorize"))
                  : h(Button, { disabled: busy !== "" || server.authorizationPending, key: "auth", onClick: () => void authorize(server.serverName), size: "sm", type: "button", variant: "primary" }, text("授权", "Authorize")),
                server.state === "unauthorized" && !server.authorizationPending
                  ? null
                  : h(Button, { disabled: busy !== "", key: "signout", onClick: () => void signOut(server.serverName), size: "sm", type: "button", variant: "ghost" }, server.authorizationPending ? text("取消授权", "Cancel authorization") : text("退出登录", "Sign out")),
                h(Button, { disabled: busy !== "", key: "remove", onClick: () => void remove(server.serverName), size: "sm", type: "button", variant: "ghost" }, text("移除", "Remove")),
              ]))),
        waiting ? h("div", { className: "pawwork-mcp-note" }, text("已在浏览器打开授权页面，完成后这里会自动更新。", "The authorization page is open in your browser; this list updates when it is done.")) : null,
        h("div", { className: "pawwork-mcp-add" },
          h(Input, { "aria-label": text("名称", "Name"), onChange: (event) => setDraft({ ...draft, serverName: event.target.value }), placeholder: text("名称，例如 linear", "Name, for example linear"), value: draft.serverName }),
          h(Input, { "aria-label": text("服务器地址", "Server URL"), onChange: (event) => setDraft({ ...draft, url: event.target.value }), placeholder: "https://mcp.example.com/mcp", value: draft.url }),
          h("textarea", { className: "pawwork-mcp-headers", "aria-label": text("自定义请求头", "Custom headers"), onChange: (event) => setDraft({ ...draft, headers: event.target.value }), placeholder: text("自定义请求头（可选），每行 名称: 值", "Custom headers (optional), one Name: Value per line"), value: draft.headers }),
          h("div", { className: "pawwork-mcp-add-actions" },
            h(Button, { disabled: !canAdd, onClick: () => void add(), size: "sm", type: "button", variant: "primary" }, text("添加", "Add")))))
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
