/**
 * CSV generation for the Reports module's export button (PHASE11.md section 2).
 *
 * Pure and renderer-side on purpose. **The CSV is built from the exact state
 * object the screen just rendered, then handed to the main process as a
 * finished string to save.** It is never re-queried main-side, because a
 * re-query could pick up a sale that landed between the render and the click —
 * and acceptance criterion 4 is that the file's totals match the on-screen
 * numbers *exactly*. What the Owner is looking at is what gets written.
 *
 * The stated reason for export in the original requirements is "share with the
 * accountant", so every choice below serves a file that opens cleanly in Excel
 * on a Windows machine and can be summed without being retyped.
 */

/**
 * One cell. Numbers and strings are handled differently on purpose — see
 * `escapeCell` for why that distinction has to survive all the way down here
 * rather than being flattened to strings by the caller.
 */
export type CsvCell = string | number | null | undefined

/**
 * Characters Excel and LibreOffice read as the start of a formula rather than
 * text. A cell beginning with one of these, in a file mailed between machines,
 * is the CSV-injection vector — `=1+1` renders as `2`, and worse things than
 * arithmetic are possible.
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r']

/**
 * Quote and escape one cell per RFC 4180, with a formula guard on text only.
 *
 * **Numbers are never guarded, and that is the reason `CsvCell` keeps the type
 * distinction.** A negative balance is `-1200`, which starts with `-` and would
 * be prefixed to `'-1200` by a blanket guard — turning every advance-holding
 * party in the Party Outstanding Report into text Excel refuses to sum, which
 * defeats the entire point of exporting raw numbers. Only strings can carry an
 * injected formula in this app's data (party names, notes, salesman names are
 * the free-text fields), so only strings are guarded.
 *
 * Null/undefined becomes an empty cell rather than the string "null" — a party
 * with no phone on file should leave a blank column, not a word.
 */
function escapeCell(cell: CsvCell): string {
  if (cell == null) return ''

  if (typeof cell === 'number') {
    // NaN/Infinity would render as literal text in a numeric column, which is
    // worse than blank because it looks like data. Nothing upstream should
    // produce one — every figure passes through `roundMoney` — so this is a
    // backstop, not an expected path.
    return Number.isFinite(cell) ? String(cell) : ''
  }

  const guarded = FORMULA_PREFIXES.some((prefix) => cell.startsWith(prefix)) ? `'${cell}` : cell

  // Leading/trailing spaces are quoted too: unquoted, some readers trim them,
  // which silently edits a party's name.
  const needsQuotes = /[",\r\n]/.test(guarded) || guarded !== guarded.trim()
  return needsQuotes ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/**
 * Builds a CSV document from a header row and body rows.
 *
 * **CRLF line endings and a UTF-8 BOM**, both for the same audience: this is a
 * Windows desktop app whose export exists to be opened in Excel. Without the
 * BOM, Excel decodes the file as the system ANSI codepage and any non-Latin
 * party name arrives as mojibake — and this shop's customer names are exactly
 * the data most likely to be non-Latin. The BOM costs three bytes and nothing
 * else; every other reader in use tolerates it.
 *
 * Rows may be ragged (a header block followed by a table is the common shape
 * here) — nothing pads them, since a short row is valid CSV and padding would
 * put empty cells where a reader expects none.
 */
export function toCsv(headers: CsvCell[], rows: CsvCell[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(','))
  return `﻿${lines.join('\r\n')}\r\n`
}

/**
 * A filesystem-safe filename stem for a report export.
 *
 * Windows rejects `\ / : * ? " < > |` in filenames outright, and this is the
 * default the save dialog opens with — an invalid default would make the Owner
 * fix the name by hand on every single export.
 */
export function reportFileName(reportName: string, rangeLabel: string): string {
  const safe = `${reportName}-${rangeLabel}`
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    // Collapse runs and trim the ends, so a name that happened to end in a
    // stripped character doesn't produce `team--2026-08-24` or a leading dash.
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  return `${safe}.csv`
}
