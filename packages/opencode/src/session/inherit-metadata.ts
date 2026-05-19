type Meta = Record<string, unknown>
type MaybeMeta = { metadata?: Meta | undefined }

export function inheritMetadata<D extends object>(source: MaybeMeta, derived: D): D & { metadata?: Meta } {
  const sourceMeta = source.metadata
  const derivedMeta = (derived as MaybeMeta).metadata
  if (!sourceMeta && !derivedMeta) return derived as D & { metadata?: Meta }

  const merged: Meta = { ...(derivedMeta ?? {}), ...(sourceMeta ?? {}) }
  if (sourceMeta?.commandTemplate === true) merged.commandTemplate = true
  return { ...derived, metadata: merged }
}
