export const UI_HMR_FULL_RELOAD_THRESHOLD = 30

function normalizePath(file) {
  return file.replace(/\\/g, "/")
}

export function isUiSourceFile(file) {
  return normalizePath(file).includes("/packages/ui/src/")
}

export function countUniqueImporters(modules) {
  const queue = [...modules]
  const visitedModules = new Set()
  const importers = new Set()

  while (queue.length > 0) {
    const current = queue.pop()
    if (!current || visitedModules.has(current)) continue
    visitedModules.add(current)

    for (const importer of current.importers ?? []) {
      if (!importer) continue
      importers.add(importer)
      queue.push(importer)
    }
  }

  return importers.size
}

export function shouldForceFullReloadForUiHmr(input) {
  if (!isUiSourceFile(input.file)) return false
  return countUniqueImporters(input.modules) >= (input.threshold ?? UI_HMR_FULL_RELOAD_THRESHOLD)
}
