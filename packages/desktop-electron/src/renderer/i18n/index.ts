import * as i18n from "@solid-primitives/i18n"

import { dict as desktopEn } from "./en"
import { dict as desktopZh } from "./zh"

import { dict as appEn } from "../../../../app/src/i18n/en"
import { dict as appZh } from "../../../../app/src/i18n/zh"

export type Locale = "en" | "zh"

type RawDictionary = typeof appEn & typeof desktopEn
type Dictionary = i18n.Flatten<RawDictionary>

const LOCALES: readonly Locale[] = ["en", "zh"]

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    const normalized = language.toLowerCase()
    if (normalized.startsWith("zh")) return "zh"
    if (normalized.startsWith("en")) return "en"
  }

  return "en"
}

function parseLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null
  const normalized = value.toLowerCase()
  if (normalized.startsWith("zh")) return "zh"
  if ((LOCALES as readonly string[]).includes(normalized)) return normalized as Locale
  return null
}

function parseRecord(value: unknown) {
  if (!value || typeof value !== "object") return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseStored(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function pickLocale(value: unknown): Locale | null {
  const direct = parseLocale(value)
  if (direct) return direct

  const record = parseRecord(value)
  if (!record) return null

  return parseLocale(record.locale)
}

const base = i18n.flatten({ ...appEn, ...desktopEn })

function build(locale: Locale): Dictionary {
  if (locale === "en") return base
  return { ...base, ...i18n.flatten(appZh), ...i18n.flatten(desktopZh) }
}

const state = {
  locale: detectLocale(),
  dict: base as Dictionary,
  init: undefined as Promise<Locale> | undefined,
}

state.dict = build(state.locale)

const translate = i18n.translator(() => state.dict, i18n.resolveTemplate)

export function t(key: keyof Dictionary, params?: Record<string, string | number>) {
  return translate(key, params)
}

export function initI18n(): Promise<Locale> {
  const cached = state.init
  if (cached) return cached

  const promise = (async () => {
    const raw = await window.api.storeGet("pawwork.global.dat", "language").catch(() => null)
    const value = parseStored(raw)
    const next = pickLocale(value) ?? state.locale

    state.locale = next
    state.dict = build(next)
    return next
  })().catch(() => state.locale)

  state.init = promise
  return promise
}
