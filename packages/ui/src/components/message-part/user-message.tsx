import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { FilePart, Part as PartType, TextPart, UserMessage } from "@opencode-ai/sdk/v2"
import { useData } from "../../context"
import { useDialog } from "../../context/dialog"
import { useI18n } from "../../context/i18n"
import { FileIcon } from "../file-icon"
import { IconButton } from "../icon-button"
import { ImagePreview } from "../image-preview"
import { Tooltip } from "../tooltip"
import { attached, inline, kind } from "../message-file"
import { CommandIcon } from "../command-icon"
import { deriveCommandInvocation } from "../../lib/command-invocation"
import type { UserActions } from "./registry"
import { HighlightedText } from "./highlighted-text"

export function UserMessageDisplay(props: { message: UserMessage; parts: PartType[]; actions?: UserActions }) {
  const data = useData()
  const dialog = useDialog()
  const i18n = useI18n()
  const [state, setState] = createStore({
    copied: false,
    busy: false,
  })
  const copied = () => state.copied
  const busy = () => state.busy

  const invocation = createMemo(() => deriveCommandInvocation(props.parts ?? []))

  const textPart = createMemo(() => {
    const inv = invocation()
    return props.parts?.find((p) => {
      if (p.type !== "text") return false
      const t = p as TextPart
      if (t.synthetic || t.ignored) return false
      if (inv && inv.suppressTextPartIds.includes(t.id)) return false
      return true
    }) as TextPart | undefined
  })

  const text = createMemo(() => textPart()?.text || "")

  const files = createMemo(() => (props.parts?.filter((p) => p.type === "file") as FilePart[]) ?? [])

  const attachments = createMemo(() => {
    const inv = invocation()
    return files()
      .filter(attached)
      .filter((f) => !inv || !inv.suppressFilePartIds.includes(f.id))
  })

  const inlineFiles = createMemo(() => files().filter(inline))

  const model = createMemo(() => {
    const providerID = props.message.model?.providerID
    const modelID = props.message.model?.modelID
    if (!providerID || !modelID) return ""
    const match = data.store.provider?.all?.find((p) => p.id === providerID)
    return match?.models?.[modelID]?.name ?? modelID
  })
  const stamp = createMemo(() => {
    const created = props.message.time?.created
    if (typeof created !== "number") return ""
    return new Intl.DateTimeFormat(i18n.locale(), { timeStyle: "short" }).format(created)
  })

  const metaHead = createMemo(() => {
    const agent = props.message.agent
    const items = [agent ? agent[0]?.toUpperCase() + agent.slice(1) : "", model()]
    return items.filter((x) => !!x).join(" · ")
  })

  const metaTail = stamp

  const openImagePreview = (url: string, alt?: string) => {
    dialog.show(() => <ImagePreview src={url} alt={alt} />)
  }

  const handleCopy = async () => {
    const inv = invocation()
    const content = inv ? inv.copyText : text()
    if (!content) return
    await navigator.clipboard.writeText(content)
    setState("copied", true)
    setTimeout(() => setState("copied", false), 2000)
  }

  const revert = () => {
    const act = props.actions?.revert
    if (!act || busy()) return
    setState("busy", true)
    void Promise.resolve()
      .then(() =>
        act({
          sessionID: props.message.sessionID,
          messageID: props.message.id,
        }),
      )
      .finally(() => setState("busy", false))
  }

  const renderAttachments = () => (
    <Show when={attachments().length > 0}>
      <div data-slot="user-message-attachments">
        <For each={attachments()}>
          {(file) => {
            const type = kind(file)
            const name = file.filename ?? i18n.t("ui.message.attachment.alt")

            const isImage = type === "image"
            const activate = () => {
              if (isImage) openImagePreview(file.url, name)
            }
            return (
              <div
                data-slot="user-message-attachment"
                data-type={type}
                data-clickable={isImage ? "true" : undefined}
                title={name}
                role={isImage ? "button" : undefined}
                tabIndex={isImage ? 0 : undefined}
                onClick={activate}
                onKeyDown={(event) => {
                  if (!isImage) return
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    activate()
                  }
                }}
              >
                <Show
                  when={type === "image"}
                  fallback={
                    <span data-slot="user-message-attachment-file">
                      <FileIcon node={{ path: name, type: "file" }} mono={true} />
                    </span>
                  }
                >
                  <img data-slot="user-message-attachment-image" src={file.url} alt={name} />
                </Show>
                <span data-slot="user-message-attachment-name-overlay">
                  <span data-slot="user-message-attachment-name">{name}</span>
                </span>
              </div>
            )
          }}
        </For>
      </div>
    </Show>
  )

  const renderMetaAndActions = () => (
    <div data-slot="user-message-copy-wrapper">
      <Show when={metaHead() || metaTail()}>
        <span data-slot="user-message-meta-wrap">
          <Show when={metaHead()}>
            <span data-slot="user-message-meta" class="text-body text-fg-weak cursor-default">
              {metaHead()}
            </span>
          </Show>
          <Show when={metaHead() && metaTail()}>
            <span data-slot="user-message-meta-sep" class="text-body text-fg-weak cursor-default">
              {" · "}
            </span>
          </Show>
          <Show when={metaTail()}>
            <span data-slot="user-message-meta-tail" class="text-body text-fg-weak cursor-default">
              {metaTail()}
            </span>
          </Show>
        </span>
      </Show>
      <Show when={props.actions?.revert}>
        <Tooltip value={i18n.t("ui.message.revertMessage")} placement="top" gutter={4}>
          <IconButton
            icon="reset"
            size="normal"
            variant="ghost"
            disabled={!!busy()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              revert()
            }}
            aria-label={i18n.t("ui.message.revertMessage")}
          />
        </Tooltip>
      </Show>
      <Tooltip
        value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
        placement="top"
        gutter={4}
      >
        <IconButton
          icon={copied() ? "check" : "copy"}
          size="normal"
          variant="ghost"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            void handleCopy()
          }}
          aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
        />
      </Tooltip>
    </div>
  )

  return (
    <div data-component="user-message">
      <Show
        when={invocation()}
        fallback={
          <>
            {renderAttachments()}
            <Show when={text()}>
              <>
                <div data-slot="user-message-body">
                  <div data-slot="user-message-text">
                    <HighlightedText text={text()} references={inlineFiles()} />
                  </div>
                </div>
                {renderMetaAndActions()}
              </>
            </Show>
          </>
        }
      >
        {(inv) => (
          <>
            <div data-slot="user-message-body">
              <div data-slot="user-message-text">
                <span data-slot="user-message-command-mark" class="user-message-command-mark">
                  <span class="user-message-command-prefix">
                    <CommandIcon icon={inv().markIcon} />
                    <span class="user-message-command-label">{inv().displayLabel}</span>
                  </span>
                  <Show when={inv().args}>
                    <span class="user-message-command-args"> {inv().args}</span>
                  </Show>
                </span>
              </div>
            </div>
            {renderMetaAndActions()}
            {renderAttachments()}
          </>
        )}
      </Show>
    </div>
  )
}
