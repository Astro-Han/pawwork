window.__ModuleLoader__.load({
  id: "@pawwork/dsh-web-search",
  factory: (require) => {
    const { createElement, useState } = require("react")
    const { IconChevronDownOutline14, Menu } = require("@deepseek-ai/dsh-client-ui-primitives")
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store")
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

    /** The names a credential reference may take; mirrors the Host's grammar. */
    const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

    /**
     * @param declared - a reference the section names, in either layer.
     * @returns the name when this deployment could resolve it; otherwise undefined.
     */
    function usableReference(declared) {
      const named = typeof declared === "string" ? declared.trim() : ""
      return CREDENTIAL_REF.test(named) ? named : undefined
    }

    /** Credential reference each engine resolves, and the section field naming it. */
    const BACKENDS = [
      { id: "exa", refField: "exaApiKeyEnv", keyless: true },
      { id: "deepseek", refField: "deepseekApiKeyEnv", keyless: false },
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
      apiKeyUnsetFree: "No key needed — searches use PawWork's included allowance. Add one to search on your own quota.",
      apiKeyUnsetRequired: "No key is configured; search is unavailable until one is.",
      keylessBadge: "Included allowance",
      configuredBadge: "Key configured",
      reset: "Reset to default",
      readOnly: "This deployment stores settings read-only.",
      save: "Save",
      saving: "Saving…",
      discard: "Discard",
      unsaved: "Unsaved",
      saveFailedKey: "The deployment did not accept the API key; it was left for you to correct.",
      saveFailedApp: "Saving failed on this app's side, not on your input. Your values were kept; try again.",
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
      apiKeyUnsetFree: "无需密钥，搜索走爪印自带额度。填入密钥则改用你自己的额度。",
      apiKeyUnsetRequired: "未配置密钥；配置之前搜索不可用。",
      keylessBadge: "自带额度",
      configuredBadge: "已配置密钥",
      reset: "恢复默认",
      readOnly: "本部署的设置为只读。",
      save: "保存",
      saving: "保存中…",
      discard: "放弃修改",
      unsaved: "未保存",
      saveFailedKey: "本部署没有接受 API Key，已保留供你修改。",
      saveFailedApp: "保存失败：应用出错，不是你输入的问题；内容已保留，可重试。",
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
     *
     * One key draft, and it carries the engine it was typed under. An API key has
     * no meaning apart from the engine it authenticates, so a staged key the card
     * is not showing must never be written: type an Exa key, switch the engine,
     * save, and a secret the user believes they abandoned reaches a second
     * vendor. `stagedKey` answers with the draft only while its engine is the one
     * on screen, which keeps what a save can write equal to what the card
     * displays.
     *
     * For the same reason `pendingWrites` is the single description of the work a
     * save has to do: the button's enabled state and the writes themselves read
     * it, so "there is something to save" cannot mean one thing to the user and
     * another to the code.
     */
    class CardController {
      /** `{ backend }`, `{ reset: true }`, or undefined — never two of them. */
      backendDraft = undefined
      keyDraft = undefined
      saving = false
      /** The field a save did not land and why: `{ field, kind }`, or undefined. */
      failure = undefined
      /** The credential the deployment is known to hold for `ref`. */
      held = { ref: "", configured: false, writable: true }
      reads = 0

      /**
       * @param scope - the bound settings scope for this card's namespace.
       * @param credentials - the credential face for the reference the section names.
       */
      constructor(scope, credentials) {
        this.scope = scope
        this.credentials = credentials
        this.store = createSnapshotStore(this.projection())
        scope.subscribe(() => {
          this.publish()
          this.readCredential()
        })
        this.readCredential()
      }

      /** @returns the backend the card is editing, staged draft included. */
      backend() {
        const snapshot = this.scope.getSnapshot()
        if (this.backendDraft?.reset === true) return snapshot.base?.backend
        return this.backendDraft?.backend ?? snapshot.value?.backend
      }

      /** @returns the descriptor of the backend currently selected. */
      spec() {
        return BACKENDS.find((entry) => entry.id === this.backend()) ?? BACKENDS[0]
      }

      /**
       * @param backend - the backend to resolve for; defaults to the selected one.
       * @returns the credential reference that backend resolves.
       */
      ref(backend = this.backend()) {
        const spec = BACKENDS.find((entry) => entry.id === backend) ?? BACKENDS[0]
        // The grammar is restated rather than imported: this bundle is loaded by
        // the renderer's module loader and cannot reach `dsh-credentials`. It has
        // to match `resolveRef` in the Host half, because a name the two read
        // differently has the card describing one reference while the search
        // resolves another — and the wire refuses anything outside it anyway.
        //
        // Both layers come from the section: `value` is the reference in force,
        // and `base` is the default the composition gives an unusable one — the
        // same default the Host falls back to. No name is copied here, so
        // changing the default moves the card with the Host.
        const snapshot = this.scope.getSnapshot()
        return usableReference(snapshot.value?.[spec.refField]) ?? usableReference(snapshot.base?.[spec.refField])
      }

      /**
       * @returns the staged key, but only while the card is showing the engine it
       *   was typed under; otherwise undefined.
       */
      stagedKey() {
        return this.keyDraft?.backend === this.backend() ? this.keyDraft : undefined
      }

      /**
       * Describe every write a save would perform, in the order it performs them.
       *
       * The key goes first. The two stores cannot commit together — the section
       * and the credential are separate authorities — so the order decides what a
       * half-finished save leaves behind, and a key written before the engine
       * moves means the engine never runs a moment without the credential it was
       * chosen for. Should the engine write then fail, the key is still filed
       * under the vendor the user was looking at when they typed it.
       *
       * Its reference comes from the draft's own engine rather than the current
       * selection: deriving the destination from anything that can move between
       * staging and writing is exactly what sent one vendor's secret to another.
       *
       * What counts as a write is decided once, here, and "staged" is not it: a
       * key that is only whitespace and an engine already in force are both
       * nothing to save, and the Save button agrees because it asks this rather
       * than deciding for itself.
       * @returns the staged writes, empty when there is nothing to save.
       */
      pendingWrites() {
        const staged = this.stagedKey()
        const writes = []
        const value = staged?.text.trim() ?? ""
        if (value.length > 0) writes.push({ field: "key", ref: this.ref(staged.backend), value })
        if (this.backendDraft?.reset === true) {
          if (Object.hasOwn(this.scope.getSnapshot().user ?? {}, "backend")) {
            writes.push({ field: "backend", reset: true })
          }
        } else if (
          this.backendDraft !== undefined &&
          this.backendDraft.backend !== this.scope.getSnapshot().value?.backend
        ) {
          writes.push({ field: "backend", backend: this.backendDraft.backend })
        }
        return writes
      }

      /** @returns whether any control holds a draft, whether or not it would write. */
      staged() {
        return this.backendDraft !== undefined || this.stagedKey() !== undefined
      }

      /** @returns whether a save would write anything. */
      dirty() {
        return this.pendingWrites().length > 0
      }

      /** @returns the state the card component renders. */
      projection() {
        const snapshot = this.scope.getSnapshot()
        const user = snapshot.user
        const spec = this.spec()
        return {
          available: snapshot.status === "ready",
          writable: snapshot.writable,
          dirty: this.dirty(),
          // Distinct from `dirty`: a key of only whitespace is a draft the user
          // can see and nothing to write, and Discard is the only way to clear it.
          staged: this.staged(),
          saving: this.saving,
          failure: this.failure,
          backend: this.backend(),
          // Offered while there is an override to remove and removing it is not
          // already staged — the control is how you stage it, so leaving it up
          // afterwards would invite pressing it twice for one effect.
          backendOverridden: Object.hasOwn(user ?? {}, "backend") && this.backendDraft?.reset !== true,
          keyless: spec.keyless,
          keyText: this.stagedKey()?.text ?? "",
          keyConfigured: this.held.configured,
          keyWritable: this.held.writable,
        }
      }

      /**
       * Ask the credentials domain about the reference now in force. Reads
       * overlap — leaving an engine and returning starts a second read of the
       * same reference — so only the newest one publishes, and one that nothing
       * answered leaves the last known state alone.
       */
      async readCredential() {
        const ref = this.ref()
        if (ref === undefined) return
        const read = ++this.reads
        if (ref !== this.held.ref) {
          this.held = { ref, configured: false, writable: true }
          this.publish()
        }
        const view = await this.credentials.inspect(ref)
        if (view === undefined || read !== this.reads) return
        const next = { ref, ...view }
        if (next.configured === this.held.configured && next.writable === this.held.writable) return
        this.held = next
        this.publish()
      }

      /**
       * Re-read after the Host reports a change to the reference this card watches.
       * @param ref - the reference the Host reports as changed.
       */
      refreshCredential(ref) {
        if (ref !== this.held.ref) return
        this.readCredential()
      }

      /** @returns the card's snapshot and its actions, for the slot registration. */
      inject() {
        return {
          hooks: { webSearchCard: this.store },
          selectBackend: (value) => {
            if (this.saving) return
            // Choosing what is already shown is not an edit. Recording it as one
            // would turn a staged reset into an explicit override of the same
            // value, pinning the user to an engine they meant to stop pinning.
            if (value === this.backend()) return
            this.backendDraft = { backend: value }
            this.failure = undefined
            this.publish()
            // The reference follows the backend, so the badge must re-resolve
            // before the user decides whether a key is still needed.
            this.readCredential()
          },
          editKey: (text) => {
            if (this.saving) return
            this.keyDraft = { backend: this.backend(), text }
            if (this.failure?.field === "key") this.failure = undefined
            this.publish()
          },
          // Stages the reset; it does not perform it. Restoring the default is
          // not a different kind of act from choosing an engine, so it stages
          // like one and `save` stays the only path to the deployment — which is
          // what lets `saving` alone serialize the card.
          resetBackend: () => {
            if (this.saving) return
            this.backendDraft = { reset: true }
            this.failure = undefined
            this.publish()
            this.readCredential()
          },
          // Returns its settlement rather than firing and forgetting: the card
          // reads progress from the store, but a caller that has to know the
          // write landed — a test, or a future surface that saves on close —
          // otherwise has nothing to wait on.
          save: () => this.save(),
          discard: () => {
            if (this.saving) return
            this.backendDraft = undefined
            this.keyDraft = undefined
            this.failure = undefined
            this.publish()
            this.readCredential()
          },
        }
      }

      /**
       * Run one settings write and report whether it completed without throwing.
       *
       * The scope reports that a write did not land, never why, so a throw is the
       * only signal that the call itself could not be made.
       * @param field - the field this write belongs to, for the failure report.
       * @param write - performs the write; its resolved value is not inspected.
       * @returns whether the write completed without throwing.
       */
      async commit(field, write) {
        try {
          await write()
          return true
        } catch (failure) {
          console.error(`[pawwork-web-search] the ${field} write could not be made:`, failure)
          this.failure = { field, kind: "broken" }
          return false
        }
      }

      /**
       * The card's only path to the deployment.
       *
       * Every control stages; this writes. That is why `saving` alone is enough
       * to serialize the card — there is no second writer to serialize against.
       *
       * The Host decides whether a value landed, so the outcome is read back
       * rather than predicted, and a field that did not land keeps its draft.
       * The two stores cannot commit together, so the writes are reported
       * independently: rolling the engine back because the key failed would be a
       * third write that can fail too, contradicting a Host that already holds
       * the new engine.
       */
      async save() {
        if (this.saving) return
        const writes = this.pendingWrites()
        if (writes.length === 0) return
        this.saving = true
        this.failure = undefined
        this.publish()
        try {
          for (const write of writes) {
            if (write.field === "key") {
              // The deployment's answer decides, and `configured` cannot stand in
              // for it: that flag is already true whenever a key was set before,
              // so a rejected rotation would read as a successful one.
              const outcome = await this.credentials.store(write.ref, write.value)
              if (outcome !== "landed") {
                // The key goes first so the engine never runs a moment without
                // the credential it was chosen for — which is exactly what
                // carrying on would produce. Any pending engine write selects
                // the engine this key was typed under, so it stays staged and
                // Save retries both rather than moving the user onto an engine
                // whose key the deployment just refused.
                this.failure = { field: "key", kind: outcome }
                break
              }
              this.keyDraft = undefined
              continue
            }
            // Read back either way. A Host that accepts the call without moving
            // the value is the case this exists for, and a reset that silently
            // did not land is the same lie as an engine that silently did not.
            const made =
              write.reset === true
                ? await this.commit("backend", () => this.scope.unset("backend"))
                : await this.commit("backend", () => this.scope.set("backend", write.backend))
            const wrote =
              made &&
              (write.reset === true
                ? !Object.hasOwn(this.scope.getSnapshot().user ?? {}, "backend")
                : this.scope.getSnapshot().user?.backend === write.backend)
            if (wrote) this.backendDraft = undefined
            else if (made) this.failure = { field: "backend", kind: "broken" }
          }
          await this.readCredential()
        } finally {
          this.saving = false
          this.publish()
        }
      }

      publish() {
        this.store.set(this.projection())
      }
    }

    /** The Remote face's own failure codes: the call never reached an authority. */
    const GATEWAY_FAILURE = /^gateway\//

    /**
     * The credentials namespace as this card needs it: whether a key is held,
     * whether a write landed, and — when it did not — whether the deployment
     * answered at all.
     *
     * DSH publishes that namespace with positional parameters and an `{ok, value}`
     * envelope, and nothing type-checks this bundle, so the shape is a contract
     * only a test against the installed DSH can hold.
     */
    function credentialFace(ctx) {
      const answered = (error) => typeof error?.code === "string" && !GATEWAY_FAILURE.test(error.code)
      return {
        async inspect(ref) {
          let response
          try {
            response = await ctx.remote.credentials.describe([ref])
          } catch (failure) {
            console.error(`[pawwork-web-search] could not ask about "${ref}":`, failure)
            return undefined
          }
          if (response?.ok !== true) {
            if (!answered(response?.error)) {
              console.error(`[pawwork-web-search] could not ask about "${ref}":`, response?.error)
            }
            return undefined
          }
          const view = response.value?.[ref]
          return { configured: view?.configured ?? false, writable: view?.writable ?? true }
        },
        async store(ref, value) {
          let response
          try {
            response = await ctx.remote.credentials.set(ref, value)
          } catch (failure) {
            console.error(`[pawwork-web-search] the write of "${ref}" could not be made:`, failure)
            return "broken"
          }
          if (response?.ok === true) return "landed"
          if (answered(response?.error)) return "refused"
          console.error(`[pawwork-web-search] the write of "${ref}" was not delivered:`, response?.error)
          return "broken"
        },
      }
    }

    /**
     * Only the key can be blamed on the input: the engine value comes from the
     * section's own picker. The two need different copy, because "the deployment
     * did not accept these values" tells a user nothing changed while the engine
     * has moved.
     */
    function saveFailureKey(failure) {
      return failure.kind === "broken" ? "saveFailedApp" : "saveFailedKey"
    }

    /**
     * One labelled control row, matching the plugin-configuration field metrics.
     * @param props - label, badges, hint, and the control to render.
     * @returns the field row.
     */
    // A `<button>` is not a labelable element, so `htmlFor` pointing at one is
    // ignored: the browser makes no association and clicking the label does
    // nothing. Fields whose control is a button carry their label the other way
    // round, through `aria-labelledby` on the control.
    function Field(props) {
      const labelTag = props.labelledControl === true ? "span" : "label"
      return h("div", { className: "pawwork-websearch-field" },
        h("div", { className: "pawwork-websearch-field-head" },
          h(labelTag, {
            className: "pawwork-websearch-label",
            id: `${props.id}-label`,
            ...(props.labelledControl === true ? {} : { htmlFor: props.id }),
          }, props.label),
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
                disabled: disabled || state.saving,
                onClick: () => props.resetBackend(),
                type: "button",
              }, t("reset"))
              : null,
            control: h(Menu, {
              align: "start",
              anchor: h("button", {
                "aria-expanded": menuOpen,
                "aria-haspopup": "menu",
                "aria-labelledby": "pawwork-websearch-backend-label pawwork-websearch-backend",
                className: "pawwork-websearch-selector",
                // Every editing control is disabled while a save runs, because
                // the actions refuse input then anyway: rendering them live made
                // a correction typed during a slow save vanish without a trace.
                disabled: disabled || state.saving,
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
              // Rendered in place rather than portalled to the document body:
              // the primitive does not move focus into the portal or restore it
              // on close, so a portalled menu leaves keyboard users able to open
              // the list and unable to reach any item in it. In flow, tab order
              // follows the DOM and the items are the next stops after the
              // trigger.
              portal: false,
              selectedId: state.backend,
            }),
            hint: t("backendHint"),
            id: "pawwork-websearch-backend",
            label: t("backend"),
            labelledControl: true,
          }),
          h(Field, {
            badges: keyBadge,
            control: h("input", {
              autoComplete: "off",
              className: "pawwork-websearch-input",
              disabled: disabled || state.saving || !state.keyWritable,
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
            state.failure
              ? h("p", { className: "pawwork-websearch-failed", role: "status" }, t(saveFailureKey(state.failure)))
              : null,
            // Asks `staged` rather than `dirty`, and a failure counts too: a
            // draft that would write nothing is still a draft on screen, and a
            // write that failed leaving none behind otherwise rendered a message
            // with every control that could clear it disabled.
            h("button", {
              className: "pawwork-websearch-discard",
              disabled: (!state.staged && !state.failure) || state.saving,
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

    const inject = ["slots", "locale", "remote", "remote.credentials", "settingsScope"]

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), "pawwork-web-search: card dictionaries")
      const card = new CardController(ctx.settingsScope.bind({ namespace: NS }), credentialFace(ctx))
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
