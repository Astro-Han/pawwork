import type { IBuffer, IBufferCell } from "./serialize-buffer"

const equalFg = (cell1: IBufferCell, cell2: IBufferCell): boolean => {
  return cell1.getFgColorMode() === cell2.getFgColorMode() && cell1.getFgColor() === cell2.getFgColor()
}

const equalBg = (cell1: IBufferCell, cell2: IBufferCell): boolean => {
  return cell1.getBgColorMode() === cell2.getBgColorMode() && cell1.getBgColor() === cell2.getBgColor()
}

const equalFlags = (cell1: IBufferCell, cell2: IBufferCell): boolean => {
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

export type StyleDefaults = {
  fgColor: number
  bgColor: number
}

export const getStyleDefaults = (buffer: IBuffer): StyleDefaults => {
  const nullCell = buffer.getNullCell()
  return {
    fgColor: nullCell.getFgColor(),
    bgColor: nullCell.getBgColor(),
  }
}

const isAttributeDefault = (defaults: StyleDefaults, cell: IBufferCell): boolean => {
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

  return (
    fgColor === defaults.fgColor &&
    bgColor === defaults.bgColor &&
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

export const diffStyle = (defaults: StyleDefaults, cell: IBufferCell, oldCell: IBufferCell): number[] => {
  const sgrSeq: number[] = []
  const fgChanged = !equalFg(cell, oldCell)
  const bgChanged = !equalBg(cell, oldCell)
  const flagsChanged = !equalFlags(cell, oldCell)

  if (fgChanged || bgChanged || flagsChanged) {
    if (isAttributeDefault(defaults, cell)) {
      if (!isAttributeDefault(defaults, oldCell)) {
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
