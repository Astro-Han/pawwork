import type { ITerminalCore, IBufferRange } from "ghostty-web"
import type { IBuffer, IBufferCell } from "./serialize-buffer"

export function constrain(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high))
}

function equalFg(cell1: IBufferCell, cell2: IBufferCell): boolean {
  return cell1.getFgColorMode() === cell2.getFgColorMode() && cell1.getFgColor() === cell2.getFgColor()
}

function equalBg(cell1: IBufferCell, cell2: IBufferCell): boolean {
  return cell1.getBgColorMode() === cell2.getBgColorMode() && cell1.getBgColor() === cell2.getBgColor()
}

function equalFlags(cell1: IBufferCell, cell2: IBufferCell): boolean {
  return (
    !!cell1.isInverse() === !!cell2.isInverse() &&
    !!cell1.isBold() === !!cell2.isBold() &&
    !!cell1.isUnderline() === !!cell2.isUnderline() &&
    !!cell1.isBlink() === !!cell2.isBlink() &&
    !!cell1.isInvisible() === !!cell2.isInvisible() &&
    !!cell1.isItalic() === !!cell2.isItalic() &&
    !!cell1.isDim() === !!cell2.isDim() &&
    !!cell1.isStrikethrough() === !!cell2.isStrikethrough()
  )
}

abstract class BaseSerializeHandler {
  constructor(protected readonly _buffer: IBuffer) {}

  public serialize(range: IBufferRange, excludeFinalCursorPosition?: boolean): string {
    let oldCell = this._buffer.getNullCell()

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
          this._nextCell(c, oldCell, row, col)
          oldCell = c
        }
      }
      this._rowEnd(row, row === endRow)
    }

    this._afterSerialize()

    return this._serializeString(excludeFinalCursorPosition)
  }

  protected _nextCell(_cell: IBufferCell, _oldCell: IBufferCell, _row: number, _col: number): void {}
  protected _rowEnd(_row: number, _isLastRow: boolean): void {}
  protected _beforeSerialize(_rows: number, _startRow: number, _endRow: number): void {}
  protected _afterSerialize(): void {}
  protected _serializeString(_excludeFinalCursorPosition?: boolean): string {
    return ""
  }
}

export class StringSerializeHandler extends BaseSerializeHandler {
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
    buffer: IBuffer,
    private readonly _terminal: ITerminalCore,
  ) {
    super(buffer)
    this._cursorStyle = this._buffer.getNullCell()
  }

  protected _beforeSerialize(rows: number, start: number, _end: number): void {
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

  protected _rowEnd(row: number, isLastRow: boolean): void {
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

  private _diffStyle(cell: IBufferCell, oldCell: IBufferCell): number[] {
    const sgrSeq: number[] = []
    const fgChanged = !equalFg(cell, oldCell)
    const bgChanged = !equalBg(cell, oldCell)
    const flagsChanged = !equalFlags(cell, oldCell)

    if (fgChanged || bgChanged || flagsChanged) {
      if (this._isAttributeDefault(cell)) {
        if (!this._isAttributeDefault(oldCell)) {
          sgrSeq.push(0)
        }
      } else {
        if (flagsChanged) {
          if (!!cell.isInverse() !== !!oldCell.isInverse()) {
            sgrSeq.push(cell.isInverse() ? 7 : 27)
          }
          if (!!cell.isBold() !== !!oldCell.isBold()) {
            sgrSeq.push(cell.isBold() ? 1 : 22)
          }
          if (!!cell.isUnderline() !== !!oldCell.isUnderline()) {
            sgrSeq.push(cell.isUnderline() ? 4 : 24)
          }
          if (!!cell.isBlink() !== !!oldCell.isBlink()) {
            sgrSeq.push(cell.isBlink() ? 5 : 25)
          }
          if (!!cell.isInvisible() !== !!oldCell.isInvisible()) {
            sgrSeq.push(cell.isInvisible() ? 8 : 28)
          }
          if (!!cell.isItalic() !== !!oldCell.isItalic()) {
            sgrSeq.push(cell.isItalic() ? 3 : 23)
          }
          if (!!cell.isDim() !== !!oldCell.isDim()) {
            sgrSeq.push(cell.isDim() ? 2 : 22)
          }
          if (!!cell.isStrikethrough() !== !!oldCell.isStrikethrough()) {
            sgrSeq.push(cell.isStrikethrough() ? 9 : 29)
          }
        }
        if (fgChanged) {
          const color = cell.getFgColor()
          const mode = cell.getFgColorMode()
          if (mode === 2 || mode === 3 || mode === -1) {
            sgrSeq.push(38, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff)
          } else if (mode === 1) {
            // Palette
            if (color >= 16) {
              sgrSeq.push(38, 5, color)
            } else {
              sgrSeq.push(color & 8 ? 90 + (color & 7) : 30 + (color & 7))
            }
          } else {
            sgrSeq.push(39)
          }
        }
        if (bgChanged) {
          const color = cell.getBgColor()
          const mode = cell.getBgColorMode()
          if (mode === 2 || mode === 3 || mode === -1) {
            sgrSeq.push(48, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff)
          } else if (mode === 1) {
            // Palette
            if (color >= 16) {
              sgrSeq.push(48, 5, color)
            } else {
              sgrSeq.push(color & 8 ? 100 + (color & 7) : 40 + (color & 7))
            }
          } else {
            sgrSeq.push(49)
          }
        }
      }
    }

    return sgrSeq
  }

  private _isAttributeDefault(cell: IBufferCell): boolean {
    const mode = cell.getFgColorMode()
    const bgMode = cell.getBgColorMode()

    if (mode === 0 && bgMode === 0) {
      return (
        !cell.isBold() &&
        !cell.isItalic() &&
        !cell.isUnderline() &&
        !cell.isBlink() &&
        !cell.isInverse() &&
        !cell.isInvisible() &&
        !cell.isDim() &&
        !cell.isStrikethrough()
      )
    }

    const fgColor = cell.getFgColor()
    const bgColor = cell.getBgColor()
    const nullCell = this._buffer.getNullCell()
    const nullFg = nullCell.getFgColor()
    const nullBg = nullCell.getBgColor()

    return (
      fgColor === nullFg &&
      bgColor === nullBg &&
      !cell.isBold() &&
      !cell.isItalic() &&
      !cell.isUnderline() &&
      !cell.isBlink() &&
      !cell.isInverse() &&
      !cell.isInvisible() &&
      !cell.isDim() &&
      !cell.isStrikethrough()
    )
  }

  protected _nextCell(cell: IBufferCell, _oldCell: IBufferCell, row: number, col: number): void {
    const isPlaceHolderCell = cell.getWidth() === 0

    if (isPlaceHolderCell) {
      return
    }

    const codepoint = cell.getCode()
    const isInvalidCodepoint = codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)
    const isGarbage = isInvalidCodepoint || (codepoint >= 0xf000 && cell.getWidth() === 1)
    const isEmptyCell = codepoint === 0 || cell.getChars() === "" || isGarbage

    const sgrSeq = this._diffStyle(cell, this._cursorStyle)

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

  protected _serializeString(excludeFinalCursorPosition?: boolean): string {
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

    const sgrSeq = this._diffStyle(style, this._cursorStyle)
    if (sgrSeq.length) content += `\u001b[${sgrSeq.join(";")}m`

    return content
  }
}
