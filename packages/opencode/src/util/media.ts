const startsWith = (bytes: Uint8Array, prefix: number[]) =>
  bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value)
const startsWithAt = (bytes: Uint8Array, offset: number, prefix: number[]) =>
  bytes.length >= offset + prefix.length && prefix.every((value, index) => bytes[offset + index] === value)

const ascii = (value: string) => [...value].map((char) => char.charCodeAt(0))
const brand = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4))
const u32be = (bytes: Uint8Array, offset: number) =>
  bytes.length >= offset + 4
    ? ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
    : 0

export function isPdfAttachment(mime: string) {
  return mime === "application/pdf"
}

export function isMedia(mime: string) {
  return mime.startsWith("image/") || isPdfAttachment(mime)
}

export function isImageAttachment(mime: string) {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

export function sniffAttachmentMime(bytes: Uint8Array, fallback: string) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    startsWith(bytes.slice(8, 12), [0x57, 0x45, 0x42, 0x50])
  )
    return "image/webp"
  if (startsWithAt(bytes, 4, ascii("ftyp"))) {
    const boxSize = u32be(bytes, 0)
    const limit = Math.min(boxSize > 0 ? boxSize : bytes.length, bytes.length)
    const brands = []
    for (let offset = 8; offset + 4 <= limit; offset += 4) {
      brands.push(brand(bytes, offset))
    }
    if (brands.some((item) => item === "avif" || item === "avis")) return "image/avif"
    if (brands.some((item) => ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(item))) return "image/heic"
  }
  return fallback
}
