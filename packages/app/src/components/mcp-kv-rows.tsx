import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { For } from "solid-js"

export type McpKvRow = { key: string; value: string }

export function McpKvRows(props: {
  label: string
  description?: string
  addLabel: string
  removeLabel: string
  keyPlaceholder: string
  valuePlaceholder: string
  rows: McpKvRow[]
  maskValue?: boolean
  onAdd: () => void
  onRemove: (index: number) => void
  onChange: (index: number, key: "key" | "value", value: string) => void
}) {
  return (
    <div class="flex flex-col gap-2">
      <div>
        <div class="text-small text-fg-weak">{props.label}</div>
        {props.description && <div class="text-small text-fg-weaker">{props.description}</div>}
      </div>
      <For each={props.rows}>
        {(row, index) => (
          <div class="flex items-start gap-2">
            <div class="flex-1">
              <TextField
                label={props.keyPlaceholder}
                hideLabel
                placeholder={props.keyPlaceholder}
                value={row.key}
                onChange={(value) => props.onChange(index(), "key", value)}
              />
            </div>
            <div class="flex-1">
              <TextField
                type={props.maskValue ? "password" : "text"}
                label={props.valuePlaceholder}
                hideLabel
                placeholder={props.valuePlaceholder}
                value={row.value}
                onChange={(value) => props.onChange(index(), "value", value)}
              />
            </div>
            <IconButton
              type="button"
              icon="trash"
              variant="ghost"
              class="mt-1"
              onClick={() => props.onRemove(index())}
              disabled={props.rows.length <= 1}
              aria-label={props.removeLabel}
            />
          </div>
        )}
      </For>
      <Button type="button" variant="ghost" icon="plus-small" onClick={props.onAdd} class="self-start">
        {props.addLabel}
      </Button>
    </div>
  )
}
