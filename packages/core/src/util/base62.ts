const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const MAX_UNBIASED_BYTE = Math.floor(256 / CHARS.length) * CHARS.length

export function randomBase62(length: number, randomBytes: (length: number) => ArrayLike<number>): string {
  let result = ""
  while (result.length < length) {
    const bytes = randomBytes(length - result.length)
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]
      if (byte >= MAX_UNBIASED_BYTE) continue
      result += CHARS[byte % CHARS.length]
      if (result.length === length) break
    }
  }
  return result
}
