// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BACKUP_TIME,
  ON_CLOSE_SKIP_WINDOW_MS,
  isScheduledBackupDue,
  nextScheduledRun,
  shouldBackupOnClose,
  validateScheduleTime,
} from './backupSchedule.ts'

/**
 * The schedule is the one part of the backup feature that can be tested
 * without a network, and it is also the part whose failure mode is silence: a
 * schedule that quietly never fires looks identical to one that has nothing to
 * do. PHASE12.md section 3 then gates the irreversible day-30 purge on a
 * successful backup existing, so "did not run" becomes "deleted anyway" one
 * prompt later.
 *
 * Every instant below is built from **local wall-clock parts**, the same
 * technique `reports.test.ts` uses, so these assertions mean the same thing on
 * any machine's timezone. `sqliteUtc` converts one back into the UTC string
 * SQLite's `datetime('now')` would actually have written for that moment,
 * which is what `backup_log.created_at` holds.
 */
function local(year: number, month: number, day: number, hours = 0, minutes = 0): Date {
  return new Date(year, month - 1, day, hours, minutes, 0, 0)
}

function sqliteUtc(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

describe('validateScheduleTime', () => {
  it('accepts a 24-hour time', () => {
    expect(validateScheduleTime('21:00')).toBeNull()
    expect(validateScheduleTime('00:00')).toBeNull()
    expect(validateScheduleTime('23:59')).toBeNull()
    expect(validateScheduleTime(DEFAULT_BACKUP_TIME)).toBeNull()
  })

  it('rejects blank, 12-hour and out-of-range values', () => {
    expect(validateScheduleTime('')).toMatch(/required/)
    expect(validateScheduleTime('9pm')).toMatch(/24-hour/)
    expect(validateScheduleTime('24:00')).toMatch(/24-hour/)
    expect(validateScheduleTime('21:60')).toMatch(/24-hour/)
  })
})

describe('isScheduledBackupDue', () => {
  it('is due when there has never been a successful backup', () => {
    expect(isScheduledBackupDue(null, '21:00', local(2026, 8, 26, 9, 0))).toBe(true)
  })

  it('is not due when a backup already succeeded after the last scheduled time', () => {
    // 21:00 last night ran; it is now 09:00, and tonight's slot has not arrived.
    const lastNight = sqliteUtc(local(2026, 8, 25, 21, 5))
    expect(isScheduledBackupDue(lastNight, '21:00', local(2026, 8, 26, 9, 0))).toBe(false)
  })

  it('is due once the scheduled time has passed for a day with no backup since', () => {
    const yesterdayEvening = sqliteUtc(local(2026, 8, 25, 21, 5))
    expect(isScheduledBackupDue(yesterdayEvening, '21:00', local(2026, 8, 26, 21, 1))).toBe(true)
  })

  /**
   * The case the whole design turns on. A machine switched off at 21:00 would,
   * under a naive "is it 21:00 now?" check, answer no at every single check and
   * the shop would go weeks without a backup while Settings said "daily".
   */
  it('catches up a slot missed while the machine was off', () => {
    const threeDaysAgo = sqliteUtc(local(2026, 8, 23, 21, 5))
    // Opened at 09:00 — well before tonight's slot, but last night's was missed.
    expect(isScheduledBackupDue(threeDaysAgo, '21:00', local(2026, 8, 26, 9, 0))).toBe(true)
  })

  it('does not fire twice for the same slot', () => {
    const justRan = sqliteUtc(local(2026, 8, 26, 21, 0))
    expect(isScheduledBackupDue(justRan, '21:00', local(2026, 8, 26, 21, 30))).toBe(false)
  })

  /**
   * The IST trap, made explicit. `backup_log.created_at` is UTC and the
   * schedule is local; in IST those are 5.5 hours apart. A backup taken at
   * 00:30 local is stored as the *previous* UTC day, and a comparison that
   * skipped the conversion would read it as older than it is and fire a
   * redundant backup — or, with the sign the other way, skip a real one.
   */
  it('compares against the shop clock, not UTC', () => {
    const justAfterMidnightLocal = local(2026, 8, 26, 0, 30)
    const stored = sqliteUtc(justAfterMidnightLocal)
    // Last slot due was 21:00 the previous evening, which this backup is after.
    expect(isScheduledBackupDue(stored, '21:00', local(2026, 8, 26, 9, 0))).toBe(false)
  })

  it('treats an unparseable timestamp as never backed up rather than as recent', () => {
    expect(isScheduledBackupDue('not a timestamp', '21:00', local(2026, 8, 26, 9, 0))).toBe(true)
  })

  /** A malformed setting must not fire a backup on every 15-minute check. */
  it('never fires on an invalid schedule time', () => {
    expect(isScheduledBackupDue(null, 'whenever', local(2026, 8, 26, 9, 0))).toBe(false)
  })
})

describe('nextScheduledRun', () => {
  it('is today when the time has not passed yet', () => {
    const next = nextScheduledRun('21:00', local(2026, 8, 26, 9, 0))!
    expect(next.getTime()).toBe(local(2026, 8, 26, 21, 0).getTime())
  })

  it('rolls to tomorrow once the slot for today has passed', () => {
    const next = nextScheduledRun('21:00', local(2026, 8, 26, 21, 30))!
    expect(next.getTime()).toBe(local(2026, 8, 27, 21, 0).getTime())
  })

  it('is null for an invalid time, so nothing claims a next run it cannot make', () => {
    expect(nextScheduledRun('whenever', local(2026, 8, 26, 9, 0))).toBeNull()
  })
})

describe('shouldBackupOnClose', () => {
  it('runs when nothing has ever succeeded', () => {
    expect(shouldBackupOnClose(null, local(2026, 8, 26, 21, 30))).toBe(true)
  })

  it('skips when a backup succeeded inside the window, so the usual evening close is instant', () => {
    const now = local(2026, 8, 26, 21, 30)
    const tenMinutesAgo = sqliteUtc(new Date(now.getTime() - 10 * 60 * 1000))
    expect(shouldBackupOnClose(tenMinutesAgo, now)).toBe(false)
  })

  it('runs once the window has elapsed', () => {
    const now = local(2026, 8, 26, 21, 30)
    const stale = sqliteUtc(new Date(now.getTime() - ON_CLOSE_SKIP_WINDOW_MS - 60_000))
    expect(shouldBackupOnClose(stale, now)).toBe(true)
  })
})
