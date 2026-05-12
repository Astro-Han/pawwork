import { Show, splitProps, type ComponentProps } from "solid-js"
import { Icon, type IconName } from "./icon"
import "./attachment-chip.css"

/**
 * Shared attachment chip for slice 11b.1. Replaces the ad-hoc chip
 * implementations the user-message bubble and (eventually) the composer
 * dock used to maintain side-by-side, ensuring "one attachment spec across
 * the product" per DESIGN.md L444.
 *
 * The single shape difference between bubble (archived state) and dock
 * (editor state) is the close button — controlled by the `removable` prop.
 * All other geometry (height 64 for files, 64×64 for images, radius-md,
 * 1px `--border-weaker`, transparent background, max-width 280) is
 * uniform.
 *
 * The chip is read-only display surface: it does NOT participate in the
 * focus / Tab order (DESIGN.md §a11y for attachments; §6.9 confirms).
 * When `removable` is true, the × button itself does enter the focus
 * order so keyboard users can dismiss attachments.
 */
export interface AttachmentChipProps {
  /** Kind of attachment — drives the file vs image visual branch. */
  kind: "file" | "image"
  /** Display name for files (e.g. `report.pdf`). Ignored for images. */
  name?: string
  /** Extension label shown under the filename. Defaults to the filename's tail. */
  ext?: string
  /** Image preview URL for `kind="image"`. */
  previewUrl?: string
  /** Alt text for the image; falls back to `name` then a default string. */
  alt?: string
  /** Icon shown inside the 48×48 square slot for files. Defaults to `doc-processing`. */
  icon?: IconName
  /** When true, render the × close button (composer editor state). */
  removable?: boolean
  /** Click handler for the × button. Only fires when `removable` is true. */
  onRemove?: (event: MouseEvent) => void
  /** Accessible label for the remove button (i18n-resolved by caller). */
  removeLabel?: string
}

function defaultExtFromName(name?: string): string | undefined {
  if (!name) return undefined
  const dot = name.lastIndexOf(".")
  if (dot < 0 || dot === name.length - 1) return undefined
  return name.slice(dot + 1)
}

export function AttachmentChip(rawProps: AttachmentChipProps & Omit<ComponentProps<"div">, keyof AttachmentChipProps>) {
  const [props, rest] = splitProps(rawProps, [
    "kind",
    "name",
    "ext",
    "previewUrl",
    "alt",
    "icon",
    "removable",
    "onRemove",
    "removeLabel",
  ])

  const resolvedExt = () => props.ext ?? defaultExtFromName(props.name)

  return (
    <Show
      when={props.kind === "image"}
      fallback={
        <div
          data-component="attachment-chip"
          data-kind="file"
          data-removable={props.removable || undefined}
          {...rest}
        >
          <span data-slot="attachment-chip-icon">
            <Icon name={props.icon ?? "doc-processing"} />
          </span>
          <span data-slot="attachment-chip-body">
            <Show when={props.name}>
              <span data-slot="attachment-chip-name" title={props.name}>
                {props.name}
              </span>
            </Show>
            <Show when={resolvedExt()}>
              <span data-slot="attachment-chip-ext">{resolvedExt()}</span>
            </Show>
          </span>
          <Show when={props.removable}>
            <button
              type="button"
              data-slot="attachment-chip-remove"
              aria-label={props.removeLabel}
              onClick={(event) => props.onRemove?.(event)}
            >
              <Icon name="close" />
            </button>
          </Show>
        </div>
      }
    >
      <div
        data-component="attachment-chip"
        data-kind="image"
        data-removable={props.removable || undefined}
        {...rest}
      >
        <img
          data-slot="attachment-chip-image"
          src={props.previewUrl}
          alt={props.alt ?? props.name ?? "attachment"}
        />
        <Show when={props.removable}>
          <button
            type="button"
            data-slot="attachment-chip-remove"
            aria-label={props.removeLabel}
            onClick={(event) => props.onRemove?.(event)}
          >
            <Icon name="close" />
          </button>
        </Show>
      </div>
    </Show>
  )
}
