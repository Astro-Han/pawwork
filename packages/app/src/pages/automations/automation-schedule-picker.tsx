import { Popover } from "@kobalte/core/popover"
import { Show, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import type { useLanguage } from "@/context/language"
import {
  formatScheduleDraft,
  frequencyLabel,
  SCHEDULE_FREQUENCIES,
  type ScheduleDraft,
  type ScheduleFrequency,
} from "./automation-schedule-form"

type Translate = ReturnType<typeof useLanguage>["t"]

// cron day-of-week order, Sunday first to match automations.schedule.weekday.N.
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5)

const pad = (value: number) => value.toString().padStart(2, "0")

// The Select listbox portals outside this popover's DOM, so an interaction with
// it reads as "outside" and would dismiss the popover. The Select content
// carries data-picker-content (the shared picker contract), so we keep the
// popover open whenever the interaction lands inside one.
const keepOpenForPicker = (event: { target: EventTarget | null; preventDefault: () => void }) => {
  if (event.target instanceof Element && event.target.closest("[data-picker-content]")) event.preventDefault()
}

// The Schedule knob in the create card: a popover built from the design-system
// Select primitive — frequency, an hour/minute time pair, and a weekday picker
// (weekly only). Contract mapping (draft -> cron / fireAt) lives in
// automation-schedule-form.ts.
export function AutomationSchedulePicker(props: {
  value: ScheduleDraft
  onChange: (next: ScheduleDraft) => void
  t: Translate
}): JSX.Element {
  const selectProps = { variant: "secondary" as const, size: "small" as const }

  return (
    <Popover gutter={6} placement="top-start">
      <Popover.Trigger
        data-action="automation-schedule-trigger"
        class="flex h-[30px] items-center gap-1.5 rounded-lg border border-border-weak bg-bg-base px-2.5 text-body text-fg-base hover:bg-row-hover-overlay focus:outline-none"
      >
        <Icon name="schedule" class="size-4 shrink-0 text-icon-weak" />
        <span class="truncate">{formatScheduleDraft(props.value, props.t)}</span>
        <Icon name="chevron-down" class="size-3 shrink-0 text-icon-weak" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          data-component="dropdown-menu-content"
          class="z-50 flex w-60 flex-col gap-2.5 rounded-xl border border-border-weak bg-bg-base p-3 shadow-lg outline-none"
          onPointerDownOutside={keepOpenForPicker}
          onFocusOutside={keepOpenForPicker}
        >
          <div class="text-caption uppercase tracking-wide text-fg-weak">
            {props.t("automations.create.scheduleHeading")}
          </div>

          <Select<ScheduleFrequency>
            {...selectProps}
            options={SCHEDULE_FREQUENCIES}
            current={props.value.frequency}
            value={(frequency) => frequency}
            label={(frequency) => frequencyLabel(frequency, props.t)}
            onSelect={(frequency) => frequency && props.onChange({ ...props.value, frequency })}
            triggerProps={{ "data-action": "automation-frequency-trigger" }}
          />

          <div class="flex items-center gap-1.5">
            <Select<number>
              {...selectProps}
              options={HOURS}
              current={props.value.hour}
              value={(hour) => String(hour)}
              label={(hour) => pad(hour)}
              onSelect={(hour) => hour !== undefined && props.onChange({ ...props.value, hour })}
              triggerProps={{ "data-action": "automation-schedule-hour" }}
            />
            <span class="text-body text-fg-weak">:</span>
            <Select<number>
              {...selectProps}
              options={MINUTES}
              current={props.value.minute}
              value={(minute) => String(minute)}
              label={(minute) => pad(minute)}
              onSelect={(minute) => minute !== undefined && props.onChange({ ...props.value, minute })}
              triggerProps={{ "data-action": "automation-schedule-minute" }}
            />
          </div>

          <Show when={props.value.frequency === "weekly"}>
            <Select<number>
              {...selectProps}
              options={WEEKDAYS}
              current={props.value.weekday}
              value={(weekday) => String(weekday)}
              label={(weekday) => props.t(`automations.schedule.weekday.${weekday}`)}
              onSelect={(weekday) => weekday !== undefined && props.onChange({ ...props.value, weekday })}
              triggerProps={{ "data-action": "automation-schedule-weekday" }}
            />
          </Show>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
