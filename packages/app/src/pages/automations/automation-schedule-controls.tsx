import { For, Show, type JSX } from "solid-js"
import { Popover } from "@opencode-ai/ui/popover"
import type { useLanguage } from "@/context/language"
import {
  frequencyLabel,
  scheduleTimeLabel,
  SCHEDULE_FREQUENCIES,
  type ScheduleDraft,
  type ScheduleFrequency,
} from "./automation-schedule-form"

type Translate = ReturnType<typeof useLanguage>["t"]

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5)
const pad = (value: number) => value.toString().padStart(2, "0")

// A click-to-edit token: reads like a word in the schedule sentence, no chevron.
const TOKEN_CLASS =
  "inline-flex h-[30px] items-center rounded-md px-2 text-body text-fg-strong tabular-nums hover:bg-row-hover-overlay focus:outline-none cursor-default"

// One scrollable column inside the time popover (hour or minute). Dense numeric
// list, so it uses a compact 28px row rather than the 30px picker-item contract.
function TimeColumn(props: {
  head: string
  items: number[]
  selected: number
  action: string
  onPick: (value: number) => void
}): JSX.Element {
  return (
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="px-1 pb-1 text-center text-caption text-fg-weak">{props.head}</div>
      <div class="no-scrollbar flex max-h-[160px] flex-col gap-px overflow-y-auto">
        <For each={props.items}>
          {(item) => (
            <button
              type="button"
              data-action={props.action}
              data-value={item}
              data-selected={item === props.selected ? "" : undefined}
              ref={(el) => {
                if (item === props.selected) queueMicrotask(() => el.scrollIntoView({ block: "nearest" }))
              }}
              onClick={() => props.onPick(item)}
              class="flex h-7 shrink-0 items-center justify-center rounded-md text-body tabular-nums text-fg-weak hover:bg-row-hover-overlay hover:text-fg-base focus:outline-none data-[selected]:bg-surface-interactive-base data-[selected]:text-fg-strong"
            >
              {pad(item)}
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

// Inline schedule editor for the create card (issue #950 PR7). Reads as a
// sentence — frequency as a segmented switch, then "at HH:MM", plus a weekday
// token when recurring weekly. No nested popover-of-dropdowns and no chevrons:
// the four frequencies are one tap, the time opens a single two-column popover.
// Draft -> cron/fireAt mapping lives in automation-schedule-form.ts.
export function AutomationScheduleControls(props: {
  value: ScheduleDraft
  onChange: (next: ScheduleDraft) => void
  t: Translate
  // The edit popover narrows the choices: a recurring automation cannot become
  // a one-shot (or vice versa) through update, so it only offers the
  // frequencies its kind supports. The create card omits this and gets all four.
  frequencies?: ScheduleFrequency[]
}): JSX.Element {
  return (
    <div data-component="automation-schedule" class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div
        data-action="automation-frequency"
        role="radiogroup"
        class="inline-flex h-[30px] items-center gap-0.5 rounded-lg border border-border-weak p-0.5"
      >
        <For each={props.frequencies ?? SCHEDULE_FREQUENCIES}>
          {(freq) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.value.frequency === freq}
              data-frequency={freq}
              data-selected={props.value.frequency === freq ? "" : undefined}
              onClick={() => props.onChange({ ...props.value, frequency: freq })}
              class="h-[26px] rounded-[7px] px-3 text-body text-fg-weak transition-colors hover:text-fg-base focus:outline-none data-[selected]:bg-row-active-overlay data-[selected]:text-fg-strong"
            >
              {frequencyLabel(freq, props.t)}
            </button>
          )}
        </For>
      </div>

      <div class="inline-flex items-center gap-2">
        <Show when={props.value.frequency === "weekly"}>
          <Popover
            modal
            placement="bottom-start"
            class="min-w-32"
            triggerAs="button"
            triggerProps={
              {
                type: "button",
                "data-action": "automation-weekday",
                "data-picker-trigger": "",
                "aria-haspopup": "menu",
                class: TOKEN_CLASS,
              } as never
            }
            trigger={<span>{props.t(`automations.schedule.weekday.${props.value.weekday}`)}</span>}
          >
            <div role="menu" class="flex flex-col gap-px">
              <For each={WEEKDAYS}>
                {(weekday) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={weekday === props.value.weekday}
                    data-picker-item=""
                    data-weekday={weekday}
                    data-selected={weekday === props.value.weekday ? "" : undefined}
                    onClick={() => props.onChange({ ...props.value, weekday })}
                    class="w-full text-left outline-none"
                  >
                    {props.t(`automations.schedule.weekday.${weekday}`)}
                  </button>
                )}
              </For>
            </div>
          </Popover>
        </Show>

        <span class="text-body text-fg-weak">{props.t("automations.create.at")}</span>

        <Popover
          modal
          placement="bottom-start"
          class="w-44"
          triggerAs="button"
          triggerProps={
            {
              type: "button",
              "data-action": "automation-time",
              "data-picker-trigger": "",
              "aria-haspopup": "menu",
              class: TOKEN_CLASS,
            } as never
          }
          trigger={<span>{scheduleTimeLabel(props.value)}</span>}
        >
          <div class="flex gap-2">
            <TimeColumn
              head={props.t("automations.create.hour")}
              items={HOURS}
              selected={props.value.hour}
              action="automation-time-hour"
              onPick={(hour) => props.onChange({ ...props.value, hour })}
            />
            <TimeColumn
              head={props.t("automations.create.minute")}
              items={MINUTES}
              selected={props.value.minute}
              action="automation-time-minute"
              onPick={(minute) => props.onChange({ ...props.value, minute })}
            />
          </div>
        </Popover>
      </div>
    </div>
  )
}
