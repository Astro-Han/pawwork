window.__ModuleLoader__.load({
  id: "@pawwork/dsh-web-search",
  factory: (require) => {
    const { createElement, useState } = require("react")
    const { IconChevronDownOutline14, Menu } = require("@deepseek-ai/dsh-client-ui-primitives")
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client")
    const h = createElement

    // The settings card for the PawWork search provider.
    //
    // A Host settings namespace renders nothing on its own: the configurable tab
    // draws the intersection of the namespaces the Host serves and the cards
    // registered for them, and the shipped cards cover `bash`, `agent-loop` and
    // `web-search-deepseek` only. So a card is not decoration here — without
    // this file the section exists and no user can reach it.
    //
    // The upstream web-search card is keyed to `web-search-deepseek` and edits
    // that provider's section, so it cannot express a choice between engines.
    // This card owns the `pawwork-web-search` namespace instead, and is the only
    // surface where the free-allowance behaviour is stated: the Exa engine
    // works with no key, which is a promise the section itself cannot make. It
    // is also the answer to "the free allowance ran out" — the one place a user
    // can move onto their own quota.
    //
    // The card shell and field rows are hand-built rather than imported. The
    // plugins section's own shell is package-private and its bundle purity gate
    // forbids importing it by value, so what is shared with it is the visual
    // contract — the same `--dsw-*` tokens, metrics, and states — not code.

    const NS = "pawwork-web-search"

    /** Credential reference each engine resolves, and the section field naming it. */
    const BACKENDS = [
      { id: "exa", refField: "exaApiKeyEnv", defaultRef: "EXA_API_KEY", keyless: true },
      { id: "deepseek", refField: "deepseekApiKeyEnv", defaultRef: "DEEPSEEK_API_KEY", keyless: false },
    ]

    const css = `
.pawwork-websearch-card {
  background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  list-style: none; transition: border-color .16s, background .16s;
}
.pawwork-websearch-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.pawwork-websearch-card-open { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
.pawwork-websearch-header {
  align-items: center; appearance: none; background: 0 0; border: 0; border-radius: 12px; color: inherit;
  cursor: pointer; display: flex; font: inherit; gap: 12px; padding: 14px 16px; text-align: left; width: 100%;
}
.pawwork-websearch-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.pawwork-websearch-head-text { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
.pawwork-websearch-name { color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600; line-height: 1.4; }
.pawwork-websearch-description { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.5; }
.pawwork-websearch-pending {
  background: var(--dsw-alias-bg-module-platform); border-radius: 999px; color: var(--dsw-alias-label-secondary);
  flex: none; font-size: 11px; font-weight: 500; line-height: 17px; padding: 1px 8px; white-space: nowrap;
}
.pawwork-websearch-chevron { color: var(--dsw-alias-label-tertiary); flex: none; transition: transform .16s; }
.pawwork-websearch-chevron-open { transform: rotate(180deg); }
.pawwork-websearch-body { border-top: 1px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px; }
.pawwork-websearch-read-only { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; margin: 12px 0 0; }
.pawwork-websearch-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.pawwork-websearch-field + .pawwork-websearch-field { border-top: 1px solid var(--dsw-alias-border-l2); }
.pawwork-websearch-field-head { align-items: center; display: flex; gap: 8px; }
.pawwork-websearch-label { color: var(--dsw-alias-label-primary); flex: 1; font-size: 13px; font-weight: 500; line-height: 1.5; min-width: 0; }
.pawwork-websearch-badges { align-items: center; display: inline-flex; gap: 8px; }
.pawwork-websearch-badge {
  background: var(--dsw-alias-bg-module-platform); border-radius: 999px; color: var(--dsw-alias-label-secondary);
  font-size: 11px; font-weight: 500; line-height: 17px; padding: 1px 8px; white-space: nowrap;
}
.pawwork-websearch-badge-muted {
  border-radius: 999px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 17px;
  padding: 1px 8px; white-space: nowrap;
}
.pawwork-websearch-reset {
  background: 0 0; border: none; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit;
  font-size: 12px; line-height: 1.5; padding: 0;
}
.pawwork-websearch-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.pawwork-websearch-reset:disabled { cursor: default; }
.pawwork-websearch-input {
  background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  box-sizing: border-box; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; height: 34px;
  line-height: 1.5; padding: 0 12px; width: 100%;
}
.pawwork-websearch-input:focus-visible { border-color: var(--dsw-alias-brand-primary); outline: none; }
.pawwork-websearch-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
/* The engine picker is the same pill-shaped menu trigger every other
   single-choice control in settings uses — agent preset, permission mode,
   language. A native select element would be the only one in the app, and its
   popup is drawn by the OS: outside the theme, unable to follow dark mode. */
.pawwork-websearch-selector {
  align-items: center; align-self: flex-start; background: var(--dsw-alias-bg-module-platform);
  border: none; border-radius: 18px; color: var(--dsw-alias-label-primary); cursor: pointer;
  display: inline-flex; font: inherit; font-size: 14px; gap: 12px; height: 36px;
  line-height: 22px; padding: 0 14px;
}
.pawwork-websearch-selector:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.pawwork-websearch-selector:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.pawwork-websearch-selector:disabled { cursor: default; }
.pawwork-websearch-selector-chevron { color: var(--dsw-alias-label-tertiary); flex: none; }
.pawwork-websearch-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; margin: 0; }
.pawwork-websearch-footer {
  align-items: center; border-top: 1px solid var(--dsw-alias-border-l2); display: flex; gap: 8px;
  justify-content: flex-end; padding: 12px 0 4px;
}
.pawwork-websearch-failed { color: var(--dsw-alias-label-error); flex: 1; font-size: 12px; line-height: 1.5; margin: 0; min-width: 0; }
.pawwork-websearch-discard, .pawwork-websearch-save {
  appearance: none; border: 1px solid transparent; border-radius: 8px; cursor: pointer; font: inherit;
  font-size: 13px; line-height: 1.5; padding: 5px 14px;
}
.pawwork-websearch-discard { background: 0 0; border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.pawwork-websearch-discard:hover:not(:disabled) { border-color: var(--dsw-alias-label-dimmed); color: var(--dsw-alias-label-primary); }
.pawwork-websearch-save { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.pawwork-websearch-discard:disabled, .pawwork-websearch-save:disabled { cursor: default; opacity: .4; }
.pawwork-websearch-discard:focus-visible, .pawwork-websearch-save:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px;
}
`

    const styleId = "@pawwork/dsh-web-search"
    if (document.querySelector(`style[data-plugin-css="${styleId}"]`) === null) {
      const style = document.createElement("style")
      style.dataset.plugin = styleId
      style.dataset.pluginCss = styleId
      style.textContent = css
      document.head.appendChild(style)
    }

    const en = {
      title: "Web search",
      description: "Which engine answers the agent's searches.",
      backend: "Search engine",
      backendHint: "Applies to the next search; no restart needed.",
      exa: "Exa",
      deepseek: "DeepSeek",
      apiKey: "API key",
      apiKeyHint: "Stored outside the settings file. Leave blank to keep the current key.",
      apiKeySet: "A key is configured.",
      apiKeyUnsetFree: "No key needed — searches use PawWork's included allowance. Add one to search on your own quota.",
      apiKeyUnsetRequired: "No key is configured; search is unavailable until one is.",
      keylessBadge: "Included allowance",
      configuredBadge: "Key configured",
      overridden: "Overridden",
      reset: "Reset to default",
      readOnly: "This deployment stores settings read-only.",
      save: "Save",
      saving: "Saving…",
      discard: "Discard",
      unsaved: "Unsaved",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      expand: "Show settings",
      collapse: "Hide settings",
    }

    const zh = {
      title: "网页搜索",
      description: "agent 搜索网页时用哪个引擎。",
      backend: "搜索源",
      backendHint: "下一次搜索即生效，无需重启。",
      exa: "Exa",
      deepseek: "DeepSeek",
      apiKey: "API Key",
      apiKeyHint: "不写入设置文件。留空表示保持当前密钥。",
      apiKeySet: "已配置密钥。",
      apiKeyUnsetFree: "无需密钥，搜索走爪印自带额度。填入密钥则改用你自己的额度。",
      apiKeyUnsetRequired: "未配置密钥；配置之前搜索不可用。",
      keylessBadge: "自带额度",
      configuredBadge: "已配置密钥",
      overridden: "已覆盖",
      reset: "恢复默认",
      readOnly: "本部署的设置为只读。",
      save: "保存",
      saving: "保存中…",
      discard: "放弃修改",
      unsaved: "未保存",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      expand: "展开设置",
      collapse: "收起设置",
    }

    /**
     * The card's staged form over the `pawwork-web-search` section.
     *
     * Two controls, staged together so one save covers both: the backend, which
     * lives in the section, and the key for whichever backend is selected, which
     * does not — a secret never rides a settings response, so the card learns only
     * whether one is configured and writes it through the credentials domain.
     */
    class CardController {
      backendDraft = undefined
      keyDraft = undefined
      saving = false
      failed = false
      credential = { ref: "", configured: false, writable: true }
      listeners = new Set()

      /**
       * @param scope - the bound settings scope for this card's namespace.
       * @param api - wire face used for the credential the section references.
       */
      constructor(scope, api) {
        this.scope = scope
        this.api = api
        this.store = createSnapshotStore(this.projection())
        this.listeners.add(() => this.store.set(this.projection()))
        scope.subscribe(() => {
          this.publish()
          this.readCredential()
        })
        this.readCredential()
      }

      /** @returns the backend the card is editing, staged draft included. */
      backend() {
        return this.backendDraft ?? this.scope.getSnapshot().value?.backend ?? "exa"
      }

      /** @returns the descriptor of the backend currently selected. */
      spec() {
        return BACKENDS.find((entry) => entry.id === this.backend()) ?? BACKENDS[0]
      }

      /** @returns the credential reference the selected backend resolves. */
      ref() {
        const spec = this.spec()
        const declared = this.scope.getSnapshot().value?.[spec.refField]
        return declared !== undefined && declared.length > 0 ? declared : spec.defaultRef
      }

      /** @returns the state the card component renders. */
      projection() {
        const snapshot = this.scope.getSnapshot()
        const user = snapshot.user
        const spec = this.spec()
        return {
          available: snapshot.status === "ready",
          writable: snapshot.writable,
          dirty: this.backendDraft !== undefined || (this.keyDraft ?? "").trim() !== "",
          saving: this.saving,
          failed: this.failed,
          backend: this.backend(),
          backendOverridden: user !== undefined && Object.hasOwn(user, "backend"),
          keyless: spec.keyless,
          keyText: this.keyDraft ?? "",
          keyConfigured: this.credential.configured,
          keyWritable: this.credential.writable,
        }
      }

      /**
       * Ask the credentials domain about the reference now in force.
       *
       * The answer is stored with the reference it describes, because switching
       * the backend changes which reference the card is asking about and two
       * reads can settle out of order.
       */
      async readCredential() {
        const ref = this.ref()
        if (ref !== this.credential.ref) {
          this.credential = { ref, configured: false, writable: true }
          this.publish()
        }
        let response
        try {
          response = await this.api.credentials.describe({ refs: [ref] })
        } catch (_credentialReadFailure) {
          return
        }
        if (!response.result.ok || ref !== this.ref()) return
        const view = response.result.value.credentials[ref]
        const next = { ref, configured: view?.configured ?? false, writable: view?.writable ?? true }
        if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
        this.credential = next
        this.publish()
      }

      /**
       * Re-read after the Host reports a change to the reference this card watches.
       * @param ref - the reference the Host reports as changed.
       */
      refreshCredential(ref) {
        if (ref !== this.credential.ref) return
        this.readCredential()
      }

      /** @returns the card's snapshot and its actions, for the slot registration. */
      inject() {
        return {
          hooks: { webSearchCard: this.store },
          selectBackend: (value) => {
            this.backendDraft = value
            this.failed = false
            this.publish()
            // The reference follows the backend, so the badge must re-resolve
            // before the user decides whether a key is still needed.
            this.readCredential()
          },
          editKey: (text) => {
            this.keyDraft = text
            this.failed = false
            this.publish()
          },
          resetBackend: () => {
            this.backendDraft = undefined
            this.failed = false
            this.publish()
            this.scope.unset("backend").then(() => this.readCredential())
          },
          // Returns its settlement rather than firing and forgetting: the card
          // reads progress from the store, but a caller that has to know the
          // write landed — a test, or a future surface that saves on close —
          // otherwise has nothing to wait on.
          save: () => this.save(),
          discard: () => {
            if (this.backendDraft === undefined && this.keyDraft === undefined && !this.failed) return
            this.backendDraft = undefined
            this.keyDraft = undefined
            this.failed = false
            this.publish()
            this.readCredential()
          },
        }
      }

      /**
       * Write both staged edits, then re-seed from what the Host accepted.
       *
       * The Host decides whether a value landed — its validators own constraints
       * no schema expresses — so the outcome is read back rather than predicted.
       * A save that did not land keeps its drafts for the user to correct. The
       * two writes settle independently, so each draft is cleared on its own
       * write landing: rolling the engine back because the key failed would
       * mean a third write that can fail too, and would contradict the Host,
       * which by then already holds the new engine.
       */
      async save() {
        if (this.saving) return
        const backendDraft = this.backendDraft
        const keyDraft = (this.keyDraft ?? "").trim()
        if (backendDraft === undefined && keyDraft === "") return
        this.saving = true
        this.failed = false
        this.publish()
        let landed = true
        if (backendDraft !== undefined) {
          let wrote = true
          try {
            await this.scope.set("backend", backendDraft)
          } catch (_writeFailure) {
            wrote = false
          }
          wrote = this.scope.getSnapshot().user?.backend === backendDraft && wrote
          if (wrote) this.backendDraft = undefined
          landed = wrote && landed
        }
        if (keyDraft !== "") {
          let wrote = true
          try {
            await this.api.credentials.set({ ref: this.ref(), value: keyDraft })
          } catch (_credentialWriteFailure) {
            wrote = false
          }
          await this.readCredential()
          wrote = this.credential.configured && wrote
          if (wrote) this.keyDraft = undefined
          landed = wrote && landed
        }
        this.saving = false
        this.failed = !landed
        this.publish()
      }

      publish() {
        for (const listener of this.listeners) listener()
      }
    }

    /**
     * One labelled control row, matching the plugin-configuration field metrics.
     * @param props - label, badges, hint, and the control to render.
     * @returns the field row.
     */
    function Field(props) {
      return h("div", { className: "pawwork-websearch-field" },
        h("div", { className: "pawwork-websearch-field-head" },
          h("label", { className: "pawwork-websearch-label", htmlFor: props.id }, props.label),
          props.badges ? h("span", { className: "pawwork-websearch-badges" }, props.badges) : null),
        props.control,
        props.hint ? h("p", { className: "pawwork-websearch-hint" }, props.hint) : null)
    }

    /**
     * The web-search card: pick the engine, and hold the key that engine needs.
     * @param props - the slot props, the card store, and the form actions.
     * @returns the card, or null before the Host serves the namespace.
     */
    function WebSearchCard(props) {
      const { t } = props
      const [open, setOpen] = useState(false)
      const [menuOpen, setMenuOpen] = useState(false)
      const state = props.useWebSearchCard((snapshot) => snapshot)
      if (!state.available) return null
      const disabled = !state.writable
      const blocked = !state.dirty || state.saving
      const keyBadge = state.keyConfigured
        ? h("span", { className: "pawwork-websearch-badge" }, t("configuredBadge"))
        : state.keyless
          ? h("span", { className: "pawwork-websearch-badge-muted" }, t("keylessBadge"))
          : null
      return h("li", { className: `pawwork-websearch-card${open ? " pawwork-websearch-card-open" : ""}` },
        h("button", {
          "aria-expanded": open,
          "aria-label": `${t(open ? "collapse" : "expand")}: ${t("title")}`,
          className: "pawwork-websearch-header",
          onClick: () => setOpen(!open),
          type: "button",
        },
          h("span", { className: "pawwork-websearch-head-text" },
            h("span", { className: "pawwork-websearch-name" }, t("title")),
            h("span", { className: "pawwork-websearch-description" }, t("description"))),
          state.dirty ? h("span", { className: "pawwork-websearch-pending" }, t("unsaved")) : null,
          h(IconChevronDownOutline14, {
            className: `pawwork-websearch-chevron${open ? " pawwork-websearch-chevron-open" : ""}`,
          })),
        open ? h("div", { className: "pawwork-websearch-body" },
          disabled ? h("p", { className: "pawwork-websearch-read-only", role: "status" }, t("readOnly")) : null,
          h(Field, {
            badges: state.backendOverridden
              ? h("button", {
                className: "pawwork-websearch-reset",
                disabled,
                onClick: () => props.resetBackend(),
                type: "button",
              }, t("reset"))
              : null,
            control: h(Menu, {
              align: "start",
              anchor: h("button", {
                "aria-expanded": menuOpen,
                "aria-haspopup": "menu",
                className: "pawwork-websearch-selector",
                disabled,
                id: "pawwork-websearch-backend",
                onClick: () => setMenuOpen(!menuOpen),
                type: "button",
              },
                t(state.backend),
                h(IconChevronDownOutline14, { className: "pawwork-websearch-selector-chevron" })),
              items: BACKENDS.map((entry) => ({ id: entry.id, label: t(entry.id) })),
              onClose: () => setMenuOpen(false),
              onSelect: (id) => {
                setMenuOpen(false)
                props.selectBackend(id)
              },
              open: menuOpen,
              portal: true,
              selectedId: state.backend,
            }),
            hint: t("backendHint"),
            id: "pawwork-websearch-backend",
            label: t("backend"),
          }),
          h(Field, {
            badges: keyBadge,
            control: h("input", {
              autoComplete: "off",
              className: "pawwork-websearch-input",
              disabled: disabled || !state.keyWritable,
              id: "pawwork-websearch-key",
              onChange: (event) => props.editKey(event.target.value),
              placeholder: state.keyConfigured ? "••••••••" : "",
              type: "password",
              value: state.keyText,
            }),
            hint: state.keyConfigured
              ? t("apiKeyHint")
              : state.keyless ? t("apiKeyUnsetFree") : t("apiKeyUnsetRequired"),
            id: "pawwork-websearch-key",
            label: t("apiKey"),
          }),
          h("div", { className: "pawwork-websearch-footer" },
            state.failed ? h("p", { className: "pawwork-websearch-failed", role: "status" }, t("saveFailed")) : null,
            h("button", {
              className: "pawwork-websearch-discard",
              disabled: !state.dirty || state.saving,
              onClick: props.discard,
              type: "button",
            }, t("discard")),
            h("button", {
              className: "pawwork-websearch-save",
              disabled: blocked || disabled,
              onClick: props.save,
              type: "button",
            }, t(state.saving ? "saving" : "save")))) : null)
    }

    const inject = ["slots", "locale", "connection", "remote", "settingsScope"]

    function apply(ctx) {
      const { api } = ctx.get("connection")
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), "pawwork-web-search: card dictionaries")
      const card = new CardController(ctx.settingsScope.bind({ namespace: NS }), api)
      ctx.effect(
        () => ctx.remote.$on("credentials/reference-updated", (ref) => card.refreshCredential(ref)),
        "pawwork-web-search: credential invalidations",
      )
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        key: NS,
        locale: NS,
        inject: () => card.inject(),
      }, WebSearchCard))
    }

    return { inject, apply }
  },
})
