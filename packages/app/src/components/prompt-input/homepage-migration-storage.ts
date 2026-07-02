// Platform-aware raw storage I/O for homepage draft migration.
// Lives in its own module so that pages/layout.tsx — a visual shell file
// gated by shell-frame-contract.test.ts — does not contain a
// `platform.platform === "desktop"` branch.

import type { Platform } from "@/context/platform"

export type RawStorageTarget = { storage?: string; key: string }

export interface RawStorageIO {
  read: (target: RawStorageTarget) => Promise<string | null>
  write: (target: RawStorageTarget, value: string) => Promise<void>
}

export function createMigrationStorageIO(platform: Platform): RawStorageIO {
  const isDesktop = platform.platform === "desktop" && !!platform.storage

  const read = async (target: RawStorageTarget): Promise<string | null> => {
    if (isDesktop) {
      return platform.storage?.(target.storage)?.getItem(target.key) ?? null
    }
    const { localStorageWithPrefix, localStorageDirect } = await import("@/utils/persist-local-storage")
    const store = target.storage ? localStorageWithPrefix(target.storage) : localStorageDirect()
    return store.getItem(target.key)
  }

  const write = async (target: RawStorageTarget, value: string): Promise<void> => {
    if (isDesktop) {
      await platform.storage?.(target.storage)?.setItem(target.key, value)
      return
    }
    const { localStorageWithPrefix, localStorageDirect } = await import("@/utils/persist-local-storage")
    const store = target.storage ? localStorageWithPrefix(target.storage) : localStorageDirect()
    store.setItem(target.key, value)
  }

  return { read, write }
}
