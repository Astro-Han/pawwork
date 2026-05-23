/**
 * SerializeAddon - Serialize terminal buffer contents
 *
 * Port of xterm.js addon-serialize for ghostty-web.
 * Enables serialization of terminal contents to a string that can
 * be written back to restore terminal state.
 *
 * Usage:
 * ```typescript
 * const serializeAddon = new SerializeAddon();
 * term.loadAddon(serializeAddon);
 * const content = serializeAddon.serialize();
 * ```
 */

import type { ITerminalAddon, ITerminalCore } from "ghostty-web"
import type { IBuffer } from "./serialize-buffer"
import { getTerminalBuffers } from "./serialize-buffer"
import { constrain, StringSerializeHandler } from "./serialize-string-handler"

// ============================================================================
// Types
// ============================================================================

export interface ISerializeOptions {
  /**
   * The row range to serialize. When an explicit range is specified, the cursor
   * will get its final repositioning.
   */
  range?: ISerializeRange
  /**
   * The number of rows in the scrollback buffer to serialize, starting from
   * the bottom of the scrollback buffer. When not specified, all available
   * rows in the scrollback buffer will be serialized.
   */
  scrollback?: number
  /**
   * Whether to exclude the terminal modes from the serialization.
   * Default: false
   */
  excludeModes?: boolean
  /**
   * Whether to exclude the alt buffer from the serialization.
   * Default: false
   */
  excludeAltBuffer?: boolean
}

export interface ISerializeRange {
  /**
   * The line to start serializing (inclusive).
   */
  start: number
  /**
   * The line to end serializing (inclusive).
   */
  end: number
}

export interface IHTMLSerializeOptions {
  /**
   * The number of rows in the scrollback buffer to serialize, starting from
   * the bottom of the scrollback buffer.
   */
  scrollback?: number
  /**
   * Whether to only serialize the selection.
   * Default: false
   */
  onlySelection?: boolean
  /**
   * Whether to include the global background of the terminal.
   * Default: false
   */
  includeGlobalBackground?: boolean
  /**
   * The range to serialize. This is prioritized over onlySelection.
   */
  range?: {
    startLine: number
    endLine: number
    startCol: number
  }
}

// ============================================================================
// SerializeAddon Class
// ============================================================================

export class SerializeAddon implements ITerminalAddon {
  private _terminal?: ITerminalCore

  /**
   * Activate the addon (called by Terminal.loadAddon)
   */
  public activate(terminal: ITerminalCore): void {
    this._terminal = terminal
  }

  /**
   * Dispose the addon and clean up resources
   */
  public dispose(): void {
    this._terminal = undefined
  }

  /**
   * Serializes terminal rows into a string that can be written back to the
   * terminal to restore the state. The cursor will also be positioned to the
   * correct cell.
   *
   * @param options Custom options to allow control over what gets serialized.
   */
  public serialize(options?: ISerializeOptions): string {
    if (!this._terminal) {
      throw new Error("Cannot use addon until it has been loaded")
    }

    const buffer = getTerminalBuffers(this._terminal)

    if (!buffer) {
      return ""
    }

    const normalBuffer = buffer.normal ?? buffer.active
    const altBuffer = buffer.alternate

    if (!normalBuffer) {
      return ""
    }

    let content = options?.range
      ? this._serializeBufferByRange(normalBuffer, options.range, true)
      : this._serializeBufferByScrollback(normalBuffer, options?.scrollback)

    if (!options?.excludeAltBuffer && buffer.active?.type === "alternate" && altBuffer) {
      const alternateContent = this._serializeBufferByScrollback(altBuffer, undefined)
      content += `\u001b[?1049h\u001b[H${alternateContent}`
    }

    return content
  }

  /**
   * Serializes terminal content as plain text (no escape sequences)
   * @param options Custom options to allow control over what gets serialized.
   */
  public serializeAsText(options?: { scrollback?: number; trimWhitespace?: boolean }): string {
    if (!this._terminal) {
      throw new Error("Cannot use addon until it has been loaded")
    }

    const buffer = getTerminalBuffers(this._terminal)

    if (!buffer) {
      return ""
    }

    const activeBuffer = buffer.active ?? buffer.normal
    if (!activeBuffer) {
      return ""
    }

    const maxRows = activeBuffer.length
    const scrollback = options?.scrollback
    const correctRows = scrollback === undefined ? maxRows : constrain(scrollback + this._terminal.rows, 0, maxRows)

    const startRow = maxRows - correctRows
    const endRow = maxRows - 1
    const lines: string[] = []

    for (let row = startRow; row <= endRow; row++) {
      const line = activeBuffer.getLine(row)
      if (line) {
        const text = line.translateToString(options?.trimWhitespace ?? true)
        lines.push(text)
      }
    }

    // Trim trailing empty lines if requested
    if (options?.trimWhitespace) {
      while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop()
      }
    }

    return lines.join("\n")
  }

  private _serializeBufferByScrollback(buffer: IBuffer, scrollback?: number): string {
    const maxRows = buffer.length
    const rows = this._terminal?.rows ?? 24
    const correctRows = scrollback === undefined ? maxRows : constrain(scrollback + rows, 0, maxRows)
    return this._serializeBufferByRange(
      buffer,
      {
        start: maxRows - correctRows,
        end: maxRows - 1,
      },
      false,
    )
  }

  private _serializeBufferByRange(
    buffer: IBuffer,
    range: ISerializeRange,
    excludeFinalCursorPosition: boolean,
  ): string {
    const handler = new StringSerializeHandler(buffer, this._terminal!)
    const cols = this._terminal?.cols ?? 80
    return handler.serialize(
      {
        start: { x: 0, y: range.start },
        end: { x: cols, y: range.end },
      },
      excludeFinalCursorPosition,
    )
  }
}
