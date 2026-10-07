/**
 * Snapshot file naming, and reading a date back out of a name.
 *
 * Pure, and separate from the Drive client for the usual reason here: anything
 * inside `electron/backup/googleDrive.ts` needs a network to exercise, so the
 * naming rules — which is what the Owner's restore list is sorted and labelled
 * by — would otherwise be untestable.
 *
 * The date is read back **out of the file name** rather than taken from Drive's
 * own `createdTime`, deliberately. The name records when the snapshot was
 * *taken*, on the shop's clock; Drive records when the bytes finished
 * uploading, in UTC. A slow upload, a retry, or a queued push during an outage
 * makes those two differ, and a restore list is a list of moments in the shop's
 * history — not of transfer completions.
 */

/** `swastik-backup-2026-08-25-2100.db` */
const NAME_PATTERN = /^swastik-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})\.db$/

/** The prefix every snapshot shares, used to scope the Drive listing query to this app's own files. */
export const SNAPSHOT_NAME_PREFIX = 'swastik-backup-'

function pad(value: number): string {
  return `${value}`.padStart(2, '0')
}

/**
 * The name a snapshot taken now should carry.
 *
 * Local date parts, matching `todayIsoDate`'s reasoning: a snapshot the Owner
 * took at 00:30 must be filed under the day they took it, not yesterday, which
 * is what a UTC derivation would do in IST.
 */
export function buildSnapshotFileName(now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`
  return `${SNAPSHOT_NAME_PREFIX}${date}-${time}.db`
}

/**
 * The local 'YYYY-MM-DD HH:MM' a snapshot was taken, or null for a name this
 * app did not write. Returning null rather than guessing keeps a stray file in
 * the Drive folder out of the restore list's chronology instead of sorting it
 * to an invented position.
 */
export function parseSnapshotFileName(fileName: string): string | null {
  const match = NAME_PATTERN.exec(fileName.trim())
  if (!match) return null
  const [, year, month, day, hours, minutes] = match
  return `${year}-${month}-${day} ${hours}:${minutes}`
}
