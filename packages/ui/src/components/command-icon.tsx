import { Show } from "solid-js"
import CommandDefault from "../assets/icons/command-default.svg?raw"
import "./command-icon.css"

// The skill glyph mirrors the "skill" entry in the chrome icon registry
// (icon.tsx): the same inner SVG content for a 0 0 20 20 viewBox, inlined here
// on purpose. Importing icon.tsx would pull its entire ~140KB registry into the
// command-icon module — and through it the app prompt-input bundle — just to
// resolve one glyph; bun's named-export analysis also chokes on that module on
// Windows. command-icon.test.ts asserts this stays in sync with icon.tsx.
export const SKILL_GLYPH = `<g transform="translate(-5.5472 34.8538) scale(0.012775 -0.012775)"><path fill-rule="evenodd" d="M1223 2650 c-25 -10 -28 -19 -43 -125 -35 -234 -127 -389 -279 -469 -65 -34 -188 -66 -254 -66 -47 0 -74 -31 -61 -68 8 -22 17 -28 54 -34 157 -24 194 -32 249 -58 112 -53 202 -160 250 -295 12 -33 29 -109 39 -170 17 -98 21 -112 44 -124 23 -13 29 -13 52 2 20 14 26 26 26 55 0 74 39 225 79 309 80 166 201 246 416 273 85 11 105 21 105 55 0 31 -31 55 -71 55 -59 0 -166 28 -232 59 -159 76 -253 235 -291 490 -10 68 -19 98 -32 108 -20 15 -21 15 -51 3z m107 -470 c50 -86 136 -164 228 -208 l73 -35 -53 -21 c-149 -61 -251 -176 -314 -354 l-22 -64 -17 54 c-60 182 -169 307 -319 366 l-47 18 86 43 c136 70 233 191 280 355 l17 58 25 -73 c13 -39 42 -102 63 -139z" fill="currentColor"/></g>`

const REGISTRY: Record<string, string> = {
  command: CommandDefault,
  skill: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">${SKILL_GLYPH}</svg>`,
}

/** Pure helper: resolves an icon key to its SVG string. No JSX or reactivity.
 *  Used by both the SolidJS component and the DOM-side input pill serializer. */
export function resolveCommandIconSvg(icon: string): string {
  return REGISTRY[icon] ?? REGISTRY.command
}

export function CommandIcon(props: { icon: string }) {
  const svg = () => resolveCommandIconSvg(props.icon)
  return (
    <Show when={svg()}>
      <span class="command-icon" data-slot="command-icon" innerHTML={svg()} aria-hidden="true" />
    </Show>
  )
}
