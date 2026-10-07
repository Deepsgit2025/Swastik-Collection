import { describe, expect, it } from 'vitest'
import { reportFileName, toCsv } from './csv.ts'

const BOM = '﻿'

/** Strips the BOM and trailing newline so a case can assert on the lines alone. */
function lines(csv: string): string[] {
  expect(csv.startsWith(BOM)).toBe(true)
  return csv.slice(BOM.length).replace(/\r\n$/, '').split('\r\n')
}

describe('toCsv', () => {
  it('writes a header row and body rows', () => {
    expect(lines(toCsv(['Party', 'Balance'], [['Ramesh Textiles', 12400]]))).toEqual([
      'Party,Balance',
      'Ramesh Textiles,12400',
    ])
  })

  it('prefixes a UTF-8 BOM so Excel does not mojibake non-Latin party names', () => {
    // Without the BOM, Excel decodes as the system ANSI codepage — and this
    // shop's customer names are exactly the data most likely to be non-Latin.
    const csv = toCsv(['Party'], [['रमेश टेक्सटाइल्स']])
    expect(csv.startsWith(BOM)).toBe(true)
    expect(csv).toContain('रमेश टेक्सटाइल्स')
  })

  it('uses CRLF line endings', () => {
    expect(toCsv(['A'], [['b']])).toBe(`${BOM}A\r\nb\r\n`)
  })

  it('quotes a cell containing a comma', () => {
    expect(lines(toCsv(['Party'], [['Ramesh, Suresh & Co']]))).toEqual([
      'Party',
      '"Ramesh, Suresh & Co"',
    ])
  })

  it('doubles internal quotes and wraps the cell', () => {
    expect(lines(toCsv(['Note'], [['He said "paid"']]))).toEqual(['Note', '"He said ""paid"""'])
  })

  it('quotes a cell containing a newline, keeping it one field', () => {
    expect(toCsv(['Note'], [['line one\nline two']])).toBe(`${BOM}Note\r\n"line one\nline two"\r\n`)
  })

  it('quotes a cell with edge whitespace, which some readers would otherwise trim', () => {
    expect(lines(toCsv(['Party'], [['  Meena Fabrics ']]))).toEqual(['Party', '"  Meena Fabrics "'])
  })

  it('writes null and undefined as empty cells, not the words', () => {
    // A party with no phone on file should leave a blank column.
    expect(lines(toCsv(['Party', 'Phone'], [['Meena Fabrics', null]]))).toEqual([
      'Party,Phone',
      'Meena Fabrics,',
    ])
  })

  it('allows ragged rows, since a header block above a table is the normal shape', () => {
    const csv = toCsv(
      ['Daily Sales Report', ''],
      [['Range', '2026-08-01 to 2026-08-24'], [], ['Figure', 'Amount'], ['Total Sales', 18400]],
    )
    expect(lines(csv)).toEqual([
      'Daily Sales Report,',
      'Range,2026-08-01 to 2026-08-24',
      '',
      'Figure,Amount',
      'Total Sales,18400',
    ])
  })
})

describe('toCsv formula-injection guard', () => {
  it.each(['=1+1', '+1', '-cmd', '@SUM(A1)', '\tinjected'])(
    'guards the text cell %j with an apostrophe',
    (value) => {
      expect(lines(toCsv(['Party'], [[value]]))[1]).toMatch(/^"?'/)
    },
  )

  it('leaves a negative number alone so Excel can still sum the column', () => {
    // The reason `CsvCell` keeps the string/number distinction: a blanket guard
    // would turn every advance-holding party's balance into `'-1200`, which is
    // text, and the Party Outstanding Report's whole point is a summable column.
    expect(lines(toCsv(['Party', 'Balance'], [['Kiran Stores', -1200]]))).toEqual([
      'Party,Balance',
      'Kiran Stores,-1200',
    ])
  })

  it('leaves ordinary text unguarded', () => {
    expect(lines(toCsv(['Party'], [['Ramesh Textiles']]))[1]).toBe('Ramesh Textiles')
  })

  it('writes a non-finite number as blank rather than as literal text', () => {
    expect(lines(toCsv(['Amount'], [[Number.NaN]]))).toEqual(['Amount', ''])
  })
})

describe('reportFileName', () => {
  it('builds a lowercase, hyphenated name ending in .csv', () => {
    expect(reportFileName('daily-sales', '2026-08-01 to 2026-08-24')).toBe(
      'daily-sales-2026-08-01-to-2026-08-24.csv',
    )
  })

  it('strips characters Windows rejects in a filename', () => {
    // This string is the save dialog's default — an invalid one would make the
    // Owner rename the file by hand on every export.
    expect(reportFileName('sales-Anil / Bhavna: "team"', '2026-08-24')).toBe(
      'sales-anil-bhavna-team-2026-08-24.csv',
    )
  })
})
