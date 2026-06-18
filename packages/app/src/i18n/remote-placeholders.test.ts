import * as i18n from "@solid-primitives/i18n"
import { expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as zh } from "./zh"

// The app resolves params with @solid-primitives/i18n's {{name}} syntax (see
// context/language.tsx, which wires t() with i18n.resolveTemplate). A single
// {name} would render literally to the user. Guard the real resolver against the
// real remote strings, in both shipped locales.
const resolve = (template: string, params: Record<string, string>) => i18n.resolveTemplate(template, params)

for (const [locale, dict] of [
  ["en", en],
  ["zh", zh],
] as const) {
  test(`remote i18n placeholders interpolate in ${locale}`, () => {
    const paired = resolve(dict["remote.pairedWith"], { name: "Ada" })
    expect(paired).toContain("Ada")
    expect(paired).not.toContain("{")

    const confirm = resolve(dict["remote.connect.confirm.body"], { name: "Ada" })
    expect(confirm).toContain("Ada")
    expect(confirm).not.toContain("{")

    // {{platform}} appears in the connect toast, its body, and the disconnect title.
    for (const key of ["remote.connect.toast.title", "remote.connect.toast.body", "remote.disconnect.title"] as const) {
      const resolved = resolve(dict[key], { platform: "Feishu" })
      expect(resolved).toContain("Feishu")
      expect(resolved).not.toContain("{")
    }
  })
}
