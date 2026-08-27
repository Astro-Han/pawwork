window.__ModuleLoader__.load({
  id: "@pawwork/dsh-web-search",
  factory: (require) => {
    const { createElement, useState } = require("react")
    const { IconChevronDownOutline14 } = require("@deepseek-ai/dsh-client-ui-primitives")
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client")
    const h = createElement

    // The settings card for the PawWork search provider.
    //
    // The upstream web-search card is keyed to `web-search-deepseek` and edits
    // that provider's section, so it cannot express a choice between backends.
    // This card owns the `pawwork-web-search` namespace instead, and is the only
    // surface where the free-allowance behaviour is stated: the Exa backend
    // works with no key, which is a promise the section itself cannot make.
    //
    // The card shell and field rows are hand-built rather than imported. The
    // plugins section's own shell is package-private and its bundle purity gate
    // forbids importing it by value, so what is shared with it is the visual
    // contract — the same `--dsw-*` tokens, metrics, and states — not code.

    const NS = "pawwork-web-search"

    /** Credential reference each backend resolves, and the section field naming it. */
    const BACKENDS = [
      { id: "exa", refField: "exaApiKeyEnv", defaultRef: "EXA_API_KEY", keyless: true },
      { id: "deepseek", refField: "deepseekApiKeyEnv", defaultRef: "DEEPSEEK_API_KEY", keyless: false },
      { id: "perplexity", refField: "perplexityApiKeyEnv", defaultRef: "PERPLEXITY_API_KEY", keyless: false },
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
/* The native control, matching the Models page: primitives ship no Select, and a
   hand-rolled listbox would drift from the platform menu the rest of settings uses. */
select.pawwork-websearch-input {
  appearance: none; cursor: pointer; max-width: 240px; padding-right: 32px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-position: right 12px center; background-repeat: no-repeat; background-size: 12px 12px;
}
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
      perplexity: "Perplexity",
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
      description: "由哪个引擎回答 agent 的搜索。",
      backend: "搜索源",
      backendHint: "下一次搜索即生效，无需重启。",
      exa: "Exa",
      deepseek: "DeepSeek",
      perplexity: "Perplexity",
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
       * A save that did not land keeps its drafts for the user to correct.
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
          try {
            await this.scope.set("backend", backendDraft)
          } catch (_writeFailure) {
            landed = false
          }
          landed = this.scope.getSnapshot().user?.backend === backendDraft && landed
        }
        if (keyDraft !== "") {
          try {
            await this.api.credentials.set({ ref: this.ref(), value: keyDraft })
          } catch (_credentialWriteFailure) {
            landed = false
          }
          await this.readCredential()
          landed = this.credential.configured && landed
        }
        if (landed) {
          this.backendDraft = undefined
          this.keyDraft = undefined
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
            control: h("select", {
              className: "pawwork-websearch-input",
              disabled,
              id: "pawwork-websearch-backend",
              onChange: (event) => props.selectBackend(event.target.value),
              value: state.backend,
            }, BACKENDS.map((entry) => h("option", { key: entry.id, value: entry.id }, t(entry.id)))),
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
