// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SNAPSHOT_NAME_PREFIX, buildSnapshotFileName, parseSnapshotFileName } from './driveSnapshot.ts'

describe('buildSnapshotFileName', () => {
  it('names a snapshot after the local moment it was taken', () => {
    // Built from local parts, so this asserts the same thing in any timezone.
    const name = buildSnapshotFileName(new Date(2026, 7, 26, 21, 5))
    expect(name).toBe('swastik-backup-2026-08-26-2105.db')
    expect(name.startsWith(SNAPSHOT_NAME_PREFIX)).toBe(true)
  })

  /**
   * A snapshot taken just after midnight must be filed under the day the Owner
   * took it. A UTC derivation would put it on the previous day in IST — the
   * same trap `todayIsoDate` exists to avoid for expense dates.
   */
  it('uses the local day just after midnight, not the UTC one', () => {
    expect(buildSnapshotFileName(new Date(2026, 7, 26, 0, 30))).toBe('swastik-backup-2026-08-26-0030.db')
  })

  it('round-trips through the parser', () => {
    const now = new Date(2026, 7, 26, 9, 7)
    expect(parseSnapshotFileName(buildSnapshotFileName(now))).toBe('2026-08-26 09:07')
  })
})

describe('parseSnapshotFileName', () => {
  it('reads the moment out of a snapshot name', () => {
    expect(parseSnapshotFileName('swastik-backup-2026-08-26-2100.db')).toBe('2026-08-26 21:00')
  })

  /**
   * Returning null rather than guessing keeps a stray file in the Drive folder
   * out of the restore list entirely, instead of sorting it to an invented
   * position among real backups.
   */
  it('returns null for anything this app did not write', () => {
    expect(parseSnapshotFileName('holiday-photo.jpg')).toBeNull()
    expect(parseSnapshotFileName('swastik-backup-2026-08-26.db')).toBeNull()
    expect(parseSnapshotFileName('backup.db')).toBeNull()
    expect(parseSnapshotFileName('')).toBeNull()
  })
})
