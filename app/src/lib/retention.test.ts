// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MIN_SNAPSHOTS_KEPT,
  RETENTION_LOCAL_DAYS,
  RETENTION_TOTAL_DAYS,
  SNAPSHOT_RETENTION_DAYS,
  retentionCutoffDate,
  snapshotsToDelete,
} from './retention.ts'
import type { RestorePoint } from '../types/backup.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** A snapshot dated `daysAgo` days back, named the way `driveSnapshot.ts` names them. */
function snapshot(daysAgo: number, id = `f${daysAgo}`): RestorePoint {
  const at = new Date(Date.now() - daysAgo * DAY_MS)
  const pad = (n: number) => `${n}`.padStart(2, '0')
  const takenAt = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  return {
    driveFileId: id,
    fileName: `swastik-backup-${takenAt.replace(' ', '-').replace(':', '')}.db`,
    takenAt,
    sizeBytes: 80000,
  }
}

/** A full run of daily snapshots, newest first, so the keep-newest floor is never the thing under test by accident. */
function dailySnapshots(count: number): RestorePoint[] {
  return Array.from({ length: count }, (_, i) => snapshot(i))
}

describe('the retention constants', () => {
  /**
   * The load-bearing arithmetic. A bill purged locally at day 30 appears in no
   * snapshot newer than day 30, so deleting snapshots at age 30 removes its
   * last copy at day 60 — exactly the rule. If someone later "corrects"
   * SNAPSHOT_RETENTION_DAYS to 60 to match the headline number, every bill
   * would linger on Drive a month past its deletion date and this fails.
   */
  it('derives the snapshot window from the local and total windows', () => {
    expect(SNAPSHOT_RETENTION_DAYS).toBe(RETENTION_TOTAL_DAYS - RETENTION_LOCAL_DAYS)
    expect(SNAPSHOT_RETENTION_DAYS).toBe(30)
  })

  it('matches the rule stated in CLAUDE.md', () => {
    expect(RETENTION_LOCAL_DAYS).toBe(30)
    expect(RETENTION_TOTAL_DAYS).toBe(60)
  })
})

describe('snapshotsToDelete', () => {
  it('deletes nothing when every snapshot is inside the window', () => {
    expect(snapshotsToDelete(dailySnapshots(20))).toEqual([])
  })

  it('deletes snapshots past 30 days old', () => {
    const points = [...dailySnapshots(MIN_SNAPSHOTS_KEPT), snapshot(31, 'old-1'), snapshot(90, 'old-2')]
    expect(snapshotsToDelete(points).map((p) => p.driveFileId).sort()).toEqual(['old-1', 'old-2'])
  })

  it('keeps a snapshot that is one day short of the window', () => {
    const points = [...dailySnapshots(MIN_SNAPSHOTS_KEPT), snapshot(29, 'not-yet')]
    expect(snapshotsToDelete(points)).toEqual([])
  })

  /**
   * A retention rule that can leave the shop with zero backups is a worse
   * failure than one that keeps a few files too long. A shop that stopped
   * trading for three months must still have something to restore from.
   */
  it('never deletes the newest few, however old they all are', () => {
    const ancient = [100, 110, 120, 130, 140, 150, 160].map((days) => snapshot(days, `a${days}`))

    const doomed = snapshotsToDelete(ancient)

    expect(doomed).toHaveLength(ancient.length - MIN_SNAPSHOTS_KEPT)
    // The survivors are the newest ones, not an arbitrary five.
    const survivors = ancient.filter((p) => !doomed.includes(p)).map((p) => p.driveFileId)
    expect(survivors).toEqual(['a100', 'a110', 'a120', 'a130', 'a140'])
  })

  it('deletes nothing at all when there are only a handful of snapshots', () => {
    expect(snapshotsToDelete([snapshot(365, 'x'), snapshot(400, 'y')])).toEqual([])
  })

  /**
   * Under `drive.file` the app only sees files it created, so a name it cannot
   * parse means something changed that this code does not understand — and the
   * response to not understanding a file is to leave it alone.
   */
  it('never deletes a snapshot whose date it cannot read', () => {
    const unreadable: RestorePoint = {
      driveFileId: 'mystery',
      fileName: 'something-else.db',
      takenAt: null,
      sizeBytes: 10,
    }
    const points = [...dailySnapshots(MIN_SNAPSHOTS_KEPT), unreadable, snapshot(90, 'genuinely-old')]

    const doomed = snapshotsToDelete(points).map((p) => p.driveFileId)
    expect(doomed).toContain('genuinely-old')
    expect(doomed).not.toContain('mystery')
  })

  it('is correct on an unsorted list, not only on the order Drive happens to return', () => {
    const points = [snapshot(90, 'old'), snapshot(0, 'a'), snapshot(2, 'c'), snapshot(1, 'b'), snapshot(3, 'd'), snapshot(4, 'e')]
    expect(snapshotsToDelete(points).map((p) => p.driveFileId)).toEqual(['old'])
  })

  it('leaves the input array untouched', () => {
    const points = [...dailySnapshots(MIN_SNAPSHOTS_KEPT), snapshot(90, 'old')]
    const before = points.map((p) => p.driveFileId)

    snapshotsToDelete(points)

    expect(points.map((p) => p.driveFileId)).toEqual(before)
  })
})

describe('retentionCutoffDate', () => {
  it('is 30 days back, as a local calendar date', () => {
    const now = new Date(2026, 7, 26, 12, 0)
    expect(retentionCutoffDate(now)).toBe('2026-07-27')
  })

  /** Built from local parts, like `todayIsoDate` — this is a date shown to a person, so it is the shop's calendar day. */
  it('uses the local day just after midnight rather than the UTC one', () => {
    expect(retentionCutoffDate(new Date(2026, 7, 26, 0, 30))).toBe('2026-07-27')
  })
})
