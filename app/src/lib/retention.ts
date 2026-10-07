import type { RestorePoint } from '../types/backup.ts'

/**
 * The 30/30 bill lifecycle (PHASE12.md section 3, CLAUDE.md) — 30 days on this
 * computer, 30 more in Drive only, gone at day 60. Changed from 30/60/90 on
 * 2026-09-19 (client decision). Cash bills count from the day they were made;
 * a credit bill counts from the day its party's balance was last cleared.
 *
 * Pure, and separate from `electron/retention/service.ts` for the same reason
 * `backupSchedule.ts` is separate from the backup service: the service needs a
 * real Electron process, a network and Drive credentials to import at all, so
 * anything left inside it is a decision that can never be tested. This is the
 * only code in the app that decides what gets destroyed, so as much of that
 * decision as possible lives here.
 */

/** Day 30: a cash bill stops living in local SQLite. */
export const RETENTION_LOCAL_DAYS = 30

/** Day 60: the bill is gone everywhere, with nothing kept. Irreversible. */
export const RETENTION_TOTAL_DAYS = 60

/**
 * How long a Drive snapshot file is kept — **derived, not chosen.**
 *
 * The spec asks for a bill to be deleted from Drive at the end of its life, as
 * though a sale were an addressable Drive object. It is not: a snapshot is a
 * whole-database file holding many bills with different expiry dates, so
 * deleting one bill from one would mean rewriting a backup. It turns out not to
 * be necessary, because the arithmetic closes on its own (shown with today's
 * 30 local + 60 total; the reasoning holds for any pair):
 *
 *   - A bill whose clock starts at `c` is purged locally at `c + 30`.
 *   - After that, no *newer* snapshot contains it — so the last snapshot
 *     holding it is the one taken at `c + 30`.
 *   - It must be gone from Drive at `c + 60`, i.e. that snapshot must be
 *     deleted at `(c + 30) + 30`.
 *
 * So a snapshot taken at T is deleted at T + 30. Checking the other end: a
 * snapshot at T holds bills whose clock started between `T - 30` and `T`; the
 * oldest needs Drive until `(T - 30) + 60 = T + 30` (exact), and the newest
 * until `T + 60`, which it gets from the later snapshots it also appears in
 * (exact). Both ends land precisely.
 *
 * Written as the subtraction rather than as a literal `30` so it cannot drift
 * away from the two numbers it follows from — a later reader "correcting" this
 * to 60 to match the headline rule would silently keep every bill on Drive a
 * month too long.
 *
 * **Caveat worth knowing:** the equivalence assumes the day-30 purge runs on
 * time. When the safeguard holds a bill back because backups were failing, that
 * bill lands in later snapshots and its Drive life stretches past day 90 —
 * late, not early, which is the safe direction.
 */
export const SNAPSHOT_RETENTION_DAYS = RETENTION_TOTAL_DAYS - RETENTION_LOCAL_DAYS

/**
 * Snapshots the sweep will never delete however old they are.
 *
 * A retention rule that can leave the shop with zero backups is a worse
 * failure than one that keeps a few files too long. This is the floor under
 * that: if a shop stops making sales for three months, the sweep still cannot
 * empty the Drive folder.
 */
export const MIN_SNAPSHOTS_KEPT = 5

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * `takenAt` is 'YYYY-MM-DD HH:MM' local wall-clock, parsed out of the snapshot's
 * own file name by `driveSnapshot.ts` — so it is compared against a local
 * `Date`, unlike the UTC `created_at` comparisons in `src/db/retention.ts`.
 */
function parseTakenAt(takenAt: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(takenAt)
  if (!match) return null
  const [, year, month, day, hours, minutes] = match
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), 0, 0)
}

/**
 * Which snapshot files are old enough to delete from Drive.
 *
 * Two rules, both protective:
 *  - a snapshot must be older than `SNAPSHOT_RETENTION_DAYS`;
 *  - the newest `MIN_SNAPSHOTS_KEPT` are never candidates, whatever their age.
 *
 * A snapshot whose date could not be parsed is **never** deleted. Under
 * `drive.file` the app can only see files it created itself, so an unparseable
 * name means something changed that this code does not understand — and the
 * response to not understanding a file is to leave it alone, not to delete it.
 */
export function snapshotsToDelete(points: RestorePoint[], now: Date = new Date()): RestorePoint[] {
  // `listSnapshots` already returns newest first; sorting here as well means
  // this function is correct on any input rather than only on that one.
  const newestFirst = [...points].sort((a, b) => ((a.takenAt ?? '') < (b.takenAt ?? '') ? 1 : -1))
  const cutoff = now.getTime() - SNAPSHOT_RETENTION_DAYS * DAY_MS

  return newestFirst.slice(MIN_SNAPSHOTS_KEPT).filter((point) => {
    if (!point.takenAt) return false
    const taken = parseTakenAt(point.takenAt)
    return taken != null && taken.getTime() < cutoff
  })
}

/**
 * The oldest date a cash bill can still be present for — what the Reports note
 * is written against, so an Owner looking at a long range is told why the cash
 * figures thin out rather than concluding the app lost their sales.
 *
 * Local date parts, matching `todayIsoDate`: this is a date shown to a person,
 * so it is the shop's calendar day.
 */
export function retentionCutoffDate(now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - RETENTION_LOCAL_DAYS * DAY_MS)
  const month = `${cutoff.getMonth() + 1}`.padStart(2, '0')
  const day = `${cutoff.getDate()}`.padStart(2, '0')
  return `${cutoff.getFullYear()}-${month}-${day}`
}
