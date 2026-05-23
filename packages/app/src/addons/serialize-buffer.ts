import type { ITerminalCore } from "ghostty-web"

export interface IBuffer {
  readonly type: "normal" | "alternate"
  readonly cursorX: number
  readonly cursorY: number
  readonly viewportY: number
  readonly baseY: number
  readonly length: number
  getLine(y: number): IBufferLine | undefined
  getNullCell(): IBufferCell
}

export interface IBufferLine {
  readonly length: number
  readonly isWrapped: boolean
  getCell(x: number): IBufferCell | undefined
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export interface IBufferCell {
  getChars(): string
  getCode(): number
  getWidth(): number
  getFgColorMode(): number
  getBgColorMode(): number
  getFgColor(): number
  getBgColor(): number
  isBold(): number
  isItalic(): number
  isUnderline(): number
  isStrikethrough(): number
  isBlink(): number
  isInverse(): number
  isInvisible(): number
  isFaint(): number
  isDim(): boolean
}

export type TerminalBuffers = {
  active?: IBuffer
  normal?: IBuffer
  alternate?: IBuffer
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null
}

const isBuffer = (value: unknown): value is IBuffer => {
  if (!isRecord(value)) return false
  if (typeof value.length !== "number") return false
  if (typeof value.cursorX !== "number") return false
  if (typeof value.cursorY !== "number") return false
  if (typeof value.baseY !== "number") return false
  if (typeof value.viewportY !== "number") return false
  if (typeof value.getLine !== "function") return false
  if (typeof value.getNullCell !== "function") return false
  return true
}

export const getTerminalBuffers = (value: ITerminalCore): TerminalBuffers | undefined => {
  if (!isRecord(value)) return
  const raw = value.buffer
  if (!isRecord(raw)) return
  const active = isBuffer(raw.active) ? raw.active : undefined
  const normal = isBuffer(raw.normal) ? raw.normal : undefined
  const alternate = isBuffer(raw.alternate) ? raw.alternate : undefined
  if (!active && !normal) return
  return { active, normal, alternate }
}
