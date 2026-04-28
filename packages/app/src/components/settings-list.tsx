import { type Component, type JSX } from "solid-js"

export const SettingsList: Component<{ children: JSX.Element }> = (props) => {
  return <div class="px-4">{props.children}</div>
}
