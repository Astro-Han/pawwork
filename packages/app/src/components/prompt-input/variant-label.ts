import type { Dictionary } from "@/context/language"

export const KNOWN_VARIANTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type KnownVariant = (typeof KNOWN_VARIANTS)[number]

type Translator = (key: keyof Dictionary) => string

export function translateVariant(t: Translator, key: string): string {
  if (key === "default") return (t("common.default") as string | undefined) ?? key
  if ((KNOWN_VARIANTS as readonly string[]).includes(key)) {
    return (t(`variant.${key as KnownVariant}` as keyof Dictionary) as string | undefined) ?? key
  }
  return key
}
