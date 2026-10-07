import { parseSqliteUtc } from './dateRange.ts'

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(amount)
}

/** `value` is a SQLite `datetime('now')` string (UTC, space-separated); `parseSqliteUtc` handles the normalization, and anything unparseable is shown as-is rather than as "Invalid Date". */
export function formatDate(value: string): string {
  const date = parseSqliteUtc(value)
  if (!date) return value
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
