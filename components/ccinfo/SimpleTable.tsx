"use client"

import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react"
import styles from "./SimpleTable.module.css"

function TableGrid({ rows, widths, editable = false, saving = false, activeRow = 0, activeColumn = 0, tableRef, onSelect, onChange, onResize }: {
  rows: string[][]; widths: number[]; editable?: boolean; saving?: boolean; activeRow?: number; activeColumn?: number
  tableRef?: RefObject<HTMLTableElement | null>
  onSelect?: (cell: { row: number; column: number }) => void
  onChange?: (row: number, column: number, value: string) => void
  onResize?: (event: ReactMouseEvent<HTMLSpanElement>, column: number) => void
}) {
  const columnCount = widths.length
  return (
    <table ref={editable ? tableRef : undefined} className={styles.table} style={editable ? { minWidth: `${Math.max(600, columnCount * 120)}px` } : undefined}>
      <colgroup>{widths.map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}</colgroup>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {Array.from({ length: columnCount }, (_, columnIndex) => {
              const selected = editable && rowIndex === activeRow && columnIndex === activeColumn
              const Cell = rowIndex === 0 ? "th" : "td"
              return (
                <Cell key={columnIndex} scope={rowIndex === 0 ? "col" : undefined} data-selected={selected || undefined}>
                  {editable ? (
                    <input
                      data-row={rowIndex}
                      data-column={columnIndex}
                      aria-label={rowIndex === 0 ? `Column ${columnIndex + 1} heading` : `Row ${rowIndex}, ${rows[0]?.[columnIndex] || `column ${columnIndex + 1}`}`}
                      value={row[columnIndex] || ""}
                      disabled={saving}
                      onFocus={() => onSelect?.({ row: rowIndex, column: columnIndex })}
                      onChange={(event) => onChange?.(rowIndex, columnIndex, event.target.value)}
                    />
                  ) : <span className={styles.cellText}>{row[columnIndex] || "\u00a0"}</span>}
                  {editable && !saving && rowIndex === 0 && columnIndex < columnCount - 1 && (
                    <span
                      className={styles.resizeHandle}
                      data-ccinfo-column-resize={columnIndex}
                      title="Drag to resize column"
                      onMouseDown={(event) => onResize?.(event, columnIndex)}
                    />
                  )}
                </Cell>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )

}

export default function SimpleTable({
  table,
  columnWidths,
  rowUpdates,
  onSave,
  readOnly = false,
  title = "table",
}: {
  table: string[][]
  columnWidths?: number[]
  rowUpdates?: string[]
  onSave?: (table: string[][], columnWidths: number[], rowUpdates: string[]) => void | Promise<void>
  readOnly?: boolean
  title?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draftRows, setDraftRows] = useState<string[][]>(table.length ? table : [["", ""], ["", ""]])
  const [draftWidths, setDraftWidths] = useState<number[]>(columnWidths || [])
  const [draftRowUpdates, setDraftRowUpdates] = useState<string[]>(rowUpdates || [])
  const [selectedCell, setSelectedCell] = useState({ row: 0, column: 0 })
  const [copied, setCopied] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const pendingFocusRef = useRef<{ row: number; column: number } | null>(null)
  const savingRef = useRef(false)
  const pastingRef = useRef(false)
  const editSessionRef = useRef(0)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const tableRef = useRef<HTMLTableElement | null>(null)
  const dragStateRef = useRef<{ startX: number; startWidths: number[]; index: number; tableWidth: number } | null>(null)
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!editing || !dialog) return
    dialog.showModal()
    return () => dialog.close()
  }, [editing])
  useLayoutEffect(() => {
    const pendingFocus = pendingFocusRef.current
    if (!editing || !pendingFocus) return
    const input = tableRef.current?.querySelector<HTMLInputElement>(`input[data-row="${pendingFocus.row}"][data-column="${pendingFocus.column}"]`)
    input?.focus({ preventScroll: true })
    input?.scrollIntoView({ block: "nearest", inline: "nearest" })
    pendingFocusRef.current = null
  })
  useEffect(() => {
    if (!editing || !dirty) return
    const preventLostEdits = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", preventLostEdits)
    return () => window.removeEventListener("beforeunload", preventLostEdits)
  }, [editing, dirty])
  useEffect(() => {
    if (!editing) return
    function handleMove(event: MouseEvent) {
      const state = dragStateRef.current
      if (!state) return
      const deltaPercent = (event.clientX - state.startX) / Math.max(state.tableWidth, 1) * 100
      const next = [...state.startWidths]
      const current = next[state.index] || 0
      const neighbor = next[state.index + 1] || 0
      const currentNext = Math.max(8, Math.min(current + deltaPercent, current + neighbor - 8))
      const neighborNext = current + neighbor - currentNext
      next[state.index] = Math.round(currentNext)
      next[state.index + 1] = Math.round(neighborNext)
      setDraftWidths(next)
      setDirty(true)
    }
    function handleUp() {
      dragStateRef.current = null
    }
    window.addEventListener("mousemove", handleMove)
    window.addEventListener("mouseup", handleUp)
    return () => {
      window.removeEventListener("mousemove", handleMove)
      window.removeEventListener("mouseup", handleUp)
    }
  }, [editing])
  const savedRows = table.length ? table : [["", ""], ["", ""]]
  const savedColumnCount = Math.max(1, ...savedRows.map((row) => row.length))
  const savedWidths = Array.from({ length: savedColumnCount }, (_, index) => columnWidths?.[index] || Math.round(100 / savedColumnCount))
  const rows = editing ? draftRows : savedRows
  const dataRowCount = Math.max(rows.length - 1, 0)
  const columnCount = Math.max(1, ...rows.map((row) => row.length))
  const widths = Array.from({ length: columnCount }).map((_, index) => (editing ? draftWidths[index] : columnWidths?.[index]) || Math.round(100 / columnCount))
  const displayRowUpdates = editing ? draftRowUpdates : rowUpdates || []
  const activeRow = Math.min(selectedCell.row, Math.max(rows.length - 1, 0))
  const activeColumn = Math.min(selectedCell.column, Math.max(columnCount - 1, 0))
  const normalizeWidths = (nextWidths: number[]) => {
    const safeWidths = nextWidths.map((width) => Math.max(6, Number.isFinite(width) ? width : 0))
    const total = safeWidths.reduce((sum, width) => sum + width, 0)
    if (!total) return Array.from({ length: Math.max(nextWidths.length, 1) }).map(() => Math.round(100 / Math.max(nextWidths.length, 1)))
    return safeWidths.map((width) => Number((width / total * 100).toFixed(2)))
  }
  const beginEditing = () => {
    editSessionRef.current += 1
    setDraftRows(rows.map((row) => [...row]))
    setDraftWidths(widths)
    setDraftRowUpdates(displayRowUpdates.length ? [...displayRowUpdates] : rows.map(() => ""))
    setSelectedCell({ row: activeRow, column: activeColumn })
    setEditing(true)
    setDirty(false)
    setError("")
    setNotice("")
    pendingFocusRef.current = { row: Math.min(1, rows.length - 1), column: 0 }
  }
  const updateRowTimestamp = (rowIndex: number, source: string[] = draftRowUpdates) => {
    const nextUpdates = [...source]
    nextUpdates[rowIndex] = new Date().toISOString()
    setDraftRowUpdates(nextUpdates)
    return nextUpdates
  }
  const updateCell = (rowIndex: number, columnIndex: number, value: string) => {
    setDirty(true)
    const next = rows.map((row) => [...row])
    while (next[rowIndex].length < columnCount) next[rowIndex].push("")
    next[rowIndex][columnIndex] = value
    setDraftRows(next)
    setSelectedCell({ row: rowIndex, column: columnIndex })
    updateRowTimestamp(rowIndex)
  }
  const insertRow = (placement: "above" | "below" | "end") => {
    // The first row is always the column heading, never an insertion target.
    const insertAt = placement === "end" ? rows.length : Math.max(1, placement === "above" ? activeRow : activeRow + 1)
    const nextRows = rows.map((row) => Array.from({ length: columnCount }).map((_, index) => row[index] || ""))
    nextRows.splice(insertAt, 0, Array.from({ length: columnCount }, () => ""))
    const nextUpdates = rows.map((_, index) => displayRowUpdates[index] || "")
    nextUpdates.splice(insertAt, 0, new Date().toISOString())
    setDraftRows(nextRows)
    setDraftRowUpdates(nextUpdates)
    const cell = { row: insertAt, column: placement === "end" ? 0 : activeColumn }
    setSelectedCell(cell)
    pendingFocusRef.current = cell
    setDirty(true)
  }
  const insertColumn = (placement: "left" | "right") => {
    const nextCount = columnCount + 1
    const insertAt = placement === "left" ? activeColumn : activeColumn + 1
    setDraftRows(rows.map((row) => {
      const nextRow = Array.from({ length: columnCount }).map((_, index) => row[index] || "")
      nextRow.splice(insertAt, 0, "")
      return nextRow
    }))
    const nextWidths = [...widths]
    const currentWidth = nextWidths[activeColumn] || Math.round(100 / columnCount)
    const splitWidth = Math.max(6, currentWidth / 2)
    nextWidths[activeColumn] = splitWidth
    nextWidths.splice(insertAt, 0, splitWidth)
    setDraftWidths(normalizeWidths(nextWidths.slice(0, nextCount)))
    setDraftRowUpdates(displayRowUpdates.length ? [...displayRowUpdates] : rows.map(() => ""))
    setSelectedCell({ row: activeRow, column: insertAt })
    pendingFocusRef.current = { row: activeRow, column: insertAt }
    setDirty(true)
  }
  const deleteSelectedRow = () => {
    if (rows.length <= 1 || activeRow === 0) return
    const nextRows = rows.filter((_, index) => index !== activeRow)
    setDraftRows(nextRows)
    setDraftRowUpdates(rows.map((_, index) => displayRowUpdates[index] || "").filter((_, index) => index !== activeRow))
    const cell = { row: Math.max(0, Math.min(activeRow, nextRows.length - 1)), column: activeColumn }
    setSelectedCell(cell)
    pendingFocusRef.current = cell
    setDirty(true)
  }
  const deleteColumn = () => {
    if (columnCount <= 1) return
    const nextCount = columnCount - 1
    setDraftRows(rows.map((row) => Array.from({ length: columnCount }).map((_, index) => row[index] || "").filter((_, index) => index !== activeColumn)))
    const nextWidths = [...widths]
    const removedWidth = nextWidths[activeColumn] || 0
    nextWidths.splice(activeColumn, 1)
    const absorbIndex = Math.max(0, Math.min(activeColumn, nextWidths.length - 1))
    nextWidths[absorbIndex] = (nextWidths[absorbIndex] || 0) + removedWidth
    setDraftWidths(normalizeWidths(nextWidths.slice(0, nextCount)))
    setDraftRowUpdates(displayRowUpdates.length ? [...displayRowUpdates] : rows.map(() => ""))
    setSelectedCell({ row: activeRow, column: Math.max(0, Math.min(activeColumn, nextCount - 1)) })
    pendingFocusRef.current = { row: activeRow, column: Math.max(0, Math.min(activeColumn, nextCount - 1)) }
    setDirty(true)
  }
  const copyTable = async () => {
    const text = rows.map((row) => Array.from({ length: columnCount }).map((_, index) => row[index] || "").join("\t")).join("\n")
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setNotice("")
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setNotice("Unable to copy. Please allow clipboard access and try again.")
    }
  }
  const pasteTable = async () => {
    if (pastingRef.current || savingRef.current) return
    const session = editSessionRef.current
    pastingRef.current = true
    setPasting(true)
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch {
      if (session === editSessionRef.current) setError("Unable to read the clipboard. Please allow clipboard access and try again.")
      return
    } finally {
      if (session === editSessionRef.current) {
        pastingRef.current = false
        setPasting(false)
      }
    }
    if (session !== editSessionRef.current) return
    setError("")
    if (!text?.trim()) return
    const incomingRows = text
      .trimEnd()
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
    const nextRows = rows.map((row) => Array.from({ length: columnCount }).map((_, index) => row[index] || ""))
    const requiredRows = activeRow + incomingRows.length
    const requiredColumns = activeColumn + Math.max(...incomingRows.map((row) => row.length))
    while (nextRows.length < requiredRows) nextRows.push(Array.from({ length: Math.max(columnCount, requiredColumns) }, () => ""))
    const nextColumnCount = Math.max(columnCount, requiredColumns)
    const now = new Date().toISOString()
    const nextUpdates = displayRowUpdates.length ? [...displayRowUpdates] : rows.map(() => "")
    for (let rowIndex = 0; rowIndex < nextRows.length; rowIndex += 1) {
      while (nextRows[rowIndex].length < nextColumnCount) nextRows[rowIndex].push("")
    }
    incomingRows.forEach((incomingRow, rowOffset) => {
      const targetRow = activeRow + rowOffset
      incomingRow.forEach((cell, columnOffset) => {
        nextRows[targetRow][activeColumn + columnOffset] = cell
      })
      nextUpdates[targetRow] = now
    })
    setDraftRows(nextRows)
    setDraftWidths(normalizeWidths(Array.from({ length: nextColumnCount }).map((_, index) => widths[index] || Math.round(100 / nextColumnCount))))
    setDraftRowUpdates(nextUpdates)
    setSelectedCell({ row: activeRow, column: activeColumn })
    pendingFocusRef.current = { row: activeRow, column: activeColumn }
    setDirty(true)
  }
  const save = async () => {
    if (!onSave || savingRef.current || pastingRef.current) return
    savingRef.current = true
    dragStateRef.current = null
    setSaving(true)
    setError("")
    try {
      await onSave(draftRows, widths, draftRowUpdates)
      setDirty(false)
      setEditing(false)
      setNotice("Table saved.")
    } catch {
      setError("Unable to save the table. Your edits are still here. Please try Save again.")
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const cancel = () => {
    if (savingRef.current) return
    if (dirty && !window.confirm("Discard your unsaved table changes?")) return
    editSessionRef.current += 1
    pastingRef.current = false
    setPasting(false)
    dragStateRef.current = null
    setEditing(false)
  }
  const beginResize = (event: ReactMouseEvent<HTMLSpanElement>, column: number) => {
    if (!tableRef.current) return
    dragStateRef.current = {
      startX: event.clientX, startWidths: [...widths], index: column,
      tableWidth: tableRef.current.getBoundingClientRect().width,
    }
    event.preventDefault()
  }
  const viewControls = (
    <div className={styles.viewControls}>
      <button type="button" onClick={beginEditing} className={styles.button}>Edit</button>
      <button type="button" onClick={() => void copyTable()} className={styles.button}>{copied ? "Copied" : "Copy Table"}</button>
      <span className={styles.rowCount}>{Math.max(table.length - 1, 0)} rows</span>
    </div>
  )
  return (
    <div data-ccinfo-table-row-count={dataRowCount} className={styles.root}>
      {!readOnly && viewControls}
      <div className={styles.preview}>
        <TableGrid rows={savedRows} widths={savedWidths} />
      </div>
      {!readOnly && !editing && table.length > 10 && viewControls}
      {notice && <div role="status" className={styles.hint}>{notice}</div>}
      {editing && (
        <dialog
          ref={dialogRef}
          className={styles.dialog}
          aria-labelledby={titleId}
          onCancel={(event) => { event.preventDefault(); cancel() }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault()
              void save()
            }
          }}
        >
          <div className={styles.editor}>
            <header className={styles.header}>
              <h2 id={titleId}>Edit {title}</h2>
              <div className={styles.hint}>Select a cell to insert beside it. Add Row appends at the end.</div>
              <fieldset className={styles.toolbar} disabled={saving || pasting}>
                <legend className={styles.srOnly}>Table editing actions</legend>
                <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => insertRow("end")}>Add Row</button>
                <button type="button" className={styles.button} onClick={() => insertRow("above")}>Row Above</button>
                <button type="button" className={styles.button} onClick={() => insertRow("below")}>Row Below</button>
                <button type="button" className={styles.button} onClick={() => insertColumn("left")}>Col Left</button>
                <button type="button" className={styles.button} onClick={() => insertColumn("right")}>Col Right</button>
                <button type="button" className={styles.button} disabled={activeRow === 0} onClick={deleteSelectedRow}>Delete Row</button>
                <button type="button" className={styles.button} disabled={columnCount <= 1} onClick={deleteColumn}>Delete Column</button>
                <button type="button" className={styles.button} onClick={() => void pasteTable()}>Paste</button>
              </fieldset>
            </header>
            <div className={styles.tableScroll} data-ccinfo-table-scroll>
              <TableGrid rows={rows} widths={widths} editable saving={saving || pasting} activeRow={activeRow} activeColumn={activeColumn} tableRef={tableRef} onSelect={setSelectedCell} onChange={updateCell} onResize={beginResize} />
            </div>
            <footer className={styles.footer}>
              <div className={styles.status}>
                <div role="status">{saving ? "Saving…" : pasting ? "Reading clipboard…" : `${dataRowCount} rows · ${activeRow === 0 ? "Heading" : `Row ${activeRow}`}, column ${activeColumn + 1}${dirty ? " · Unsaved changes" : ""}`}</div>
                <div className={styles.hint}>Tab: next cell · Ctrl/Cmd + Enter: save · Drag heading borders to resize.</div>
                {error && <div role="alert" className={styles.error}>{error}</div>}
              </div>
              <div className={styles.saveControls}>
                <button type="button" className={styles.button} disabled={saving} onClick={cancel}>Cancel</button>
                <button type="button" className={`${styles.button} ${styles.save}`} disabled={saving || pasting || !onSave} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
              </div>
            </footer>
          </div>
        </dialog>
      )}
    </div>
  )
}
