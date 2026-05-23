import type { ITerminalCore, IBufferRange } from "ghostty-web"
import type { IBuffer, IBufferCell } from "./serialize-buffer"
import { diffStyle } from "./serialize-style"

export function constrain(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high))
}

export class StringSerializeHandler {
  private _rowIndex: number = 0
  private _allRows: string[] = []
  private _allRowSeparators: string[] = []
  private _currentRow: string = ""
  private _nullCellCount: number = 0
  private _cursorStyle: IBufferCell
  private _firstRow: number = 0
  private _lastCursorRow: number = 0
  private _lastCursorCol: number = 0
  private _lastContentCursorRow: number = 0
  private _lastContentCursorCol: number = 0

  constructor(
    private readonly _buffer: IBuffer,
    private readonly _terminal: ITerminalCore,
  ) {
    this._cursorStyle = this._buffer.getNullCell()
  }

  public serialize(range: IBufferRange, excludeFinalCursorPosition?: boolean): string {
    const startRow = range.start.y
    const endRow = range.end.y
    const startColumn = range.start.x
    const endColumn = range.end.x

    this._beforeSerialize(endRow - startRow + 1, startRow, endRow)

    for (let row = startRow; row <= endRow; row++) {
      const line = this._buffer.getLine(row)
      if (line) {
        const startLineColumn = row === range.start.y ? startColumn : 0
        const endLineColumn = Math.min(endColumn, line.length)

        for (let col = startLineColumn; col < endLineColumn; col++) {
          const c = line.getCell(col)
          if (!c) {
            continue
          }
          this._nextCell(c, row, col)
        }
      }
      this._rowEnd(row, row === endRow)
    }

    return this._serializeString(excludeFinalCursorPosition)
  }

  private _beforeSerialize(rows: number, start: number, _end: number): void {
    this._allRows = new Array<string>(rows)
    this._allRowSeparators = new Array<string>(rows)
    this._rowIndex = 0

    this._currentRow = ""
    this._nullCellCount = 0
    this._cursorStyle = this._buffer.getNullCell()

    this._lastContentCursorRow = start
    this._lastCursorRow = start
    this._firstRow = start
  }

  private _rowEnd(row: number, isLastRow: boolean): void {
    let rowSeparator = ""

    const nextLine = isLastRow ? undefined : this._buffer.getLine(row + 1)
    const wrapped = !!nextLine?.isWrapped

    if (this._nullCellCount > 0 && wrapped) {
      this._currentRow += " ".repeat(this._nullCellCount)
    }

    this._nullCellCount = 0

    if (!isLastRow && !wrapped) {
      rowSeparator = "\r\n"
      this._lastCursorRow = row + 1
      this._lastCursorCol = 0
    }

    this._allRows[this._rowIndex] = this._currentRow
    this._allRowSeparators[this._rowIndex++] = rowSeparator
    this._currentRow = ""
    this._nullCellCount = 0
  }

  private _nextCell(cell: IBufferCell, row: number, col: number): void {
    const isPlaceHolderCell = cell.getWidth() === 0

    if (isPlaceHolderCell) {
      return
    }

    const codepoint = cell.getCode()
    const isInvalidCodepoint = codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)
    const isGarbage = isInvalidCodepoint || (codepoint >= 0xf000 && cell.getWidth() === 1)
    const isEmptyCell = codepoint === 0 || cell.getChars() === "" || isGarbage

    const sgrSeq = diffStyle(this._buffer, cell, this._cursorStyle)

    const styleChanged = sgrSeq.length > 0

    if (styleChanged) {
      if (this._nullCellCount > 0) {
        this._currentRow += " ".repeat(this._nullCellCount)
        this._nullCellCount = 0
      }

      this._lastContentCursorRow = this._lastCursorRow = row
      this._lastContentCursorCol = this._lastCursorCol = col

      this._currentRow += `\u001b[${sgrSeq.join(";")}m`

      const line = this._buffer.getLine(row)
      const cellFromLine = line?.getCell(col)
      if (cellFromLine) {
        this._cursorStyle = cellFromLine
      }
    }

    if (isEmptyCell) {
      this._nullCellCount += cell.getWidth()
    } else {
      if (this._nullCellCount > 0) {
        this._currentRow += " ".repeat(this._nullCellCount)
        this._nullCellCount = 0
      }

      this._currentRow += cell.getChars()

      this._lastContentCursorRow = this._lastCursorRow = row
      this._lastContentCursorCol = this._lastCursorCol = col + cell.getWidth()
    }
  }

  private _serializeString(excludeFinalCursorPosition?: boolean): string {
    let rowEnd = this._allRows.length

    if (this._buffer.length - this._firstRow <= this._terminal.rows) {
      rowEnd = this._lastContentCursorRow + 1 - this._firstRow
      this._lastCursorCol = this._lastContentCursorCol
      this._lastCursorRow = this._lastContentCursorRow
    }

    let content = ""

    for (let i = 0; i < rowEnd; i++) {
      content += this._allRows[i]
      if (i + 1 < rowEnd) {
        content += this._allRowSeparators[i]
      }
    }

    if (excludeFinalCursorPosition) return content

    const absoluteCursorRow = (this._buffer.baseY ?? 0) + this._buffer.cursorY
    const cursorRow = constrain(absoluteCursorRow - this._firstRow + 1, 1, Number.MAX_SAFE_INTEGER)
    const cursorCol = this._buffer.cursorX + 1
    content += `\u001b[${cursorRow};${cursorCol}H`

    const line = this._buffer.getLine(absoluteCursorRow)
    const cell = line?.getCell(this._buffer.cursorX)
    const style = (() => {
      if (!cell) return this._buffer.getNullCell()
      if (cell.getWidth() !== 0) return cell
      if (this._buffer.cursorX > 0) return line?.getCell(this._buffer.cursorX - 1) ?? cell
      return cell
    })()

    const sgrSeq = diffStyle(this._buffer, style, this._cursorStyle)
    if (sgrSeq.length) content += `\u001b[${sgrSeq.join(";")}m`

    return content
  }
}
