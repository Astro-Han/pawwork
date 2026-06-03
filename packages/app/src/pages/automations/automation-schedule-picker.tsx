import { Popover } from "@kobalte/core/popover"
import { createSignal, For, Show, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import type { useLanguage } from "@/context/language"
import {
  formatScheduleDraft,
  frequencyLabel,
  SCHEDULE_FREQUENCIES,
  scheduleTimeLabel,
  scheduleUsesTime,
  type ScheduleDraft,
  type ScheduleFrequency,
} from "./automation-schedule-form"

type Translate = ReturnType<typeof useLanguage>["t"]

// cron day-of-week order, Sunday first to match automations.schedule.weekday.N.
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]

const FIELD_CLASS =
  "h-[30px] w-full rounded-lg border border-border-weak bg-bg-base px-2.5 text-body text-fg-base focus:border-border-strong focus:outline-none"

// The Schedule knob in the create card: a popover whose frequency control opens
// an inline option list, plus a time control (daily/weekdays/weekly/once), a
// weekday row (weekly), and a raw cron field (custom). Read side / contract
// mapping lives in automation-schedule-form.ts.
export function AutomationSchedulePicker(props: {
  value: ScheduleDraft
  onChange: (next: ScheduleDraft) => void
  t: Translate
}): JSX.Element {
  const [freqOpen, setFreqOpen] = createSignal(false)

  const setFrequency = (frequency: ScheduleFrequency) => {
    props.onChange({ ...props.value, frequency })
    setFreqOpen(false)
  }

  const setTime = (value: string) => {
    const [hour, minute] = value.split(":").map(Number)
    if (Number.isInteger(hour) && Number.isInteger(minute)) props.onChange({ ...props.value, hour, minute })
  }

  return (
    <Popover gutter={6} placement="top-start">
      <Popover.Trigger
        data-action="automation-schedule-trigger"
        class="flex h-[30px] items-center gap-1.5 rounded-lg border border-brand/45 bg-bg-base px-2.5 text-body text-fg-base hover:bg-row-hover-overlay focus:outline-none"
      >
        <Icon name="schedule" class="size-4 text-icon-weak" />
        <span class="truncate">{formatScheduleDraft(props.value, props.t)}</span>
        <Icon name="chevron-down" class="size-3.5 shrink-0 text-icon-weak" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          data-component="dropdown-menu-content"
          class="z-50 w-60 rounded-xl border border-border-weak bg-bg-base p-1.5 shadow-lg outline-none"
        >
          <div class="px-2 pb-1 pt-1.5 text-caption uppercase tracking-wide text-fg-weak">
            {props.t("automations.create.scheduleHeading")}
          </div>

          <button
            type="button"
            data-action="automation-frequency-trigger"
            onClick={() => setFreqOpen((open) => !open)}
            class="flex h-[34px] w-full items-center justify-between rounded-lg border border-border-weak px-3 text-body text-fg-strong hover:bg-row-hover-overlay focus:outline-none"
            classList={{ "border-border-strong": freqOpen() }}
          >
            <span>{frequencyLabel(props.value.frequency, props.t)}</span>
            <Icon name="chevron-down" class="size-3.5 text-icon-weak" />
          </button>

          <Show when={freqOpen()}>
            <div class="mt-1 flex flex-col">
              <For each={SCHEDULE_FREQUENCIES}>
                {(frequency) => (
                  <button
                    type="button"
                    data-action="automation-frequency-option"
                    data-frequency={frequency}
                    data-selected={frequency === props.value.frequency ? "" : undefined}
                    onClick={() => setFrequency(frequency)}
                    class="flex h-[30px] items-center justify-between rounded-md px-3 text-body text-fg-base hover:bg-row-hover-overlay focus:outline-none"
                    classList={{ "font-emphasis text-fg-strong": frequency === props.value.frequency }}
                  >
                    <span>{frequencyLabel(frequency, props.t)}</span>
                    <Show when={frequency === props.value.frequency}>
                      <Icon name="check" class="size-3.5 text-brand" />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={scheduleUsesTime(props.value.frequency)}>
            <input
              type="time"
              data-action="automation-schedule-time"
              value={scheduleTimeLabel(props.value)}
              onInput={(event) => setTime(event.currentTarget.value)}
              class={`mt-2 ${FIELD_CLASS}`}
            />
          </Show>

          <Show when={props.value.frequency === "weekly"}>
            <div class="mt-2 flex flex-wrap gap-1">
              <For each={WEEKDAYS}>
                {(day) => (
                  <button
                    type="button"
                    data-action="automation-schedule-weekday"
                    data-weekday={day}
                    data-selected={day === props.value.weekday ? "" : undefined}
                    onClick={() => props.onChange({ ...props.value, weekday: day })}
                    class="h-7 min-w-7 rounded-md border border-border-weak px-1.5 text-caption text-fg-base hover:bg-row-hover-overlay focus:outline-none"
                    classList={{ "border-brand bg-sel text-fg-strong": day === props.value.weekday }}
                  >
                    {props.t(`automations.schedule.weekday.${day}`)}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={props.value.frequency === "custom"}>
            <input
              type="text"
              data-action="automation-schedule-cron"
              value={props.value.cron}
              onInput={(event) => props.onChange({ ...props.value, cron: event.currentTarget.value })}
              placeholder="0 9 * * *"
              spellcheck={false}
              class={`mt-2 font-mono ${FIELD_CLASS}`}
            />
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
