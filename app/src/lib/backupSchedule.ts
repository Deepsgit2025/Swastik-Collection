import { parseSqliteUtc } from './dateRange.ts'

/**
 * When an automatic backup is due (PHASE12.md sections 1-2).
 *
 * Pure and separate from `electron/backup/service.ts` for the same reason
 * `nextWhatsAppState`/`classifySocketState` live outside `whatsapp/client.ts`:
 * the service needs a real Electron process, a network and real Google
 * credentials to import at all, so any decision left inside it is a decision
 * that can never be tested. Everything about *whether* to back up lives here;
 * the service only does it.
 *
 * **Timezone is the trap, and it is the same one `src/db/reports.ts`
 * documents.** `backup_log.created_at` is `datetime('now')` — UTC — while the
 * schedule means the shop's own 9pm. In IST those are 5.5 hours apart, so a
 * naive comparison would fire the "daily" backup at half past two in the
 * afternoon, or decide last night's run already covers tonight. Every
 * comparison below converts the stored UTC timestamp with `parseSqliteUtc` and
 * builds the scheduled instant from **local** date parts.
 */

/** Default backup time — after a shop would normally have closed, before the machine is likely shut down for the night. Configurable from Settings. */
export const DEFAULT_BACKUP_TIME = '21:00'

/**
 * How recent a successful backup has to be for the on-close push to skip
 * itself.
 *
 * Closing the app shortly after the daily run is the common case, and making
 * that wait on a network round trip would make the app feel broken every
 * evening. An hour is long enough that normal closing is instant and short
 * enough that a day's work is never more than an hour from a snapshot.
 */
export const ON_CLOSE_SKIP_WINDOW_MS = 60 * 60 * 1000

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Returns the error to show, or null when `value` is a real 'HH:MM' 24-hour time. Shared by the Settings screen and `setBackupSchedule`, the same two-layer discipline as `settingsValidation.ts`. */
export function validateScheduleTime(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'A backup time is required.'
  if (!TIME_PATTERN.test(trimmed)) return 'Backup time must be a 24-hour time like 21:00.'
  return null
}

function timeParts(timeOfDay: string): { hours: number; minutes: number } | null {
  const match = TIME_PATTERN.exec(timeOfDay.trim())
  if (!match) return null
  return { hours: Number(match[1]), minutes: Number(match[2]) }
}

/**
 * The most recent moment the schedule *should* have fired, at or before `now`.
 *
 * Built with the local-parts `Date` constructor, so it lands on the shop's
 * clock rather than UTC's.
 */
function mostRecentScheduledInstant(timeOfDay: string, now: Date): Date | null {
  const parts = timeParts(timeOfDay)
  if (!parts) return null

  const todaysRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parts.hours, parts.minutes, 0, 0)
  if (todaysRun.getTime() <= now.getTime()) return todaysRun

  // Today's slot hasn't come round yet, so the last one due was yesterday's.
  // Constructed by subtracting a day from the date part rather than 24h from
  // the instant, so a DST shift can't move it off the scheduled wall-clock time.
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, parts.hours, parts.minutes, 0, 0)
}

/**
 * The next moment the schedule will fire, strictly after `now` — what the
 * Settings panel shows, so the Owner can see when rather than take it on trust.
 */
export function nextScheduledRun(timeOfDay: string, now: Date = new Date()): Date | null {
  const parts = timeParts(timeOfDay)
  if (!parts) return null

  const todaysRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parts.hours, parts.minutes, 0, 0)
  if (todaysRun.getTime() > now.getTime()) return todaysRun
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, parts.hours, parts.minutes, 0, 0)
}

/**
 * Is a scheduled backup owed right now?
 *
 * **This is what makes a missed run catch up rather than vanish.** The question
 * asked is not "is it 21:00?" — a machine that was switched off at 21:00 would
 * answer no every time it was checked, and the shop would go weeks without a
 * backup while the setting said "daily". It is "has a successful backup
 * happened since the last time one was due?", so the first launch after a
 * missed slot runs one immediately.
 *
 * That matters beyond tidiness: PHASE12.md section 3 gates the irreversible
 * day-30 local purge on a successful backup existing, so a silently skipped
 * schedule is the difference between an archived bill and a deleted one.
 *
 * An unparseable `lastSuccessAt` (or none at all) counts as due — erring
 * towards an unnecessary backup rather than a missing one.
 */
export function isScheduledBackupDue(
  lastSuccessAt: string | null,
  timeOfDay: string,
  now: Date = new Date(),
): boolean {
  const dueSince = mostRecentScheduledInstant(timeOfDay, now)
  if (!dueSince) return false // A malformed setting must not fire a backup every 15 minutes.

  if (!lastSuccessAt) return true
  const last = parseSqliteUtc(lastSuccessAt)
  if (!last) return true

  return last.getTime() < dueSince.getTime()
}

/**
 * Should the on-close push actually run?
 *
 * Only when nothing has succeeded recently — see `ON_CLOSE_SKIP_WINDOW_MS`. The
 * caller additionally skips when Drive isn't connected and bounds the attempt
 * with a timeout; quitting the app can be slow, but it must never be stuck.
 */
export function shouldBackupOnClose(lastSuccessAt: string | null, now: Date = new Date()): boolean {
  if (!lastSuccessAt) return true
  const last = parseSqliteUtc(lastSuccessAt)
  if (!last) return true
  return now.getTime() - last.getTime() >= ON_CLOSE_SKIP_WINDOW_MS
}
