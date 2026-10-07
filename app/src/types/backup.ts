/** Whether a backup attempt was fired by the schedule or by the Owner clicking Backup Now — matches `backup_log.triggered_by`'s CHECK constraint. */
export type BackupTrigger = 'scheduled' | 'manual'

/** Matches `backup_log.status`'s CHECK constraint. A *skipped* run is not logged at all — it was never an attempt. */
export type BackupStatus = 'success' | 'failed'

/**
 * One row of `backup_log`. `error` carries the reason a failure failed — see
 * migration `010_backup_log_detail.sql` for why that column is not optional in
 * spirit even though it is nullable in SQL.
 */
export interface BackupLogRow {
  id: number
  status: BackupStatus
  drive_file_id: string | null
  triggered_by: BackupTrigger
  error: string | null
  file_name: string | null
  size_bytes: number | null
  created_at: string
}

/**
 * When automatic backups run (PHASE12.md section 1's configurable schedule).
 *
 * Both are on by default. `timeOfDay` is local wall-clock 'HH:MM' — the shop's
 * 9pm, not UTC's; see `src/lib/backupSchedule.ts` for how that comparison is
 * done, and `src/db/reports.ts` for the same timezone trap in the reporting
 * layer.
 */
export interface BackupSchedule {
  /** 'HH:MM', 24-hour, local time. */
  timeOfDay: string
  /** Also push a snapshot as the app closes. Bounded and skipped when a recent backup already succeeded — see `runOnCloseBackupIfDue`. */
  onAppClose: boolean
}

/**
 * What the Settings screen is told about Google Drive.
 *
 * Deliberately carries **no tokens and no client secret** — the renderer learns
 * only whether a secret is configured, never its value, the same discipline
 * that keeps `password_hash` out of `UserListRow`. The refresh token never
 * leaves the main process at all (`electron/backup/tokenStore.ts`).
 */
export interface BackupStatusView {
  /** The OAuth client id. Not a secret — Google publishes it in the consent URL — so it round-trips to the screen for editing. */
  clientId: string
  /** Whether a client secret is on file. Its value is never sent to the renderer; re-typing it is how it gets changed. */
  hasClientSecret: boolean
  /** Whether a usable Drive authorization is stored. */
  connected: boolean
  /** The Google account the Owner authorized, when known — so they can see *which* Drive this is backing up to. */
  connectedEmail: string | null
  schedule: BackupSchedule
  lastSuccessAt: string | null
  /** Local 'YYYY-MM-DD HH:MM' of the next scheduled run, or null when nothing is scheduled. */
  nextRunAt: string | null
  recentAttempts: BackupLogRow[]
}

/** One snapshot in Drive that the Owner could restore from. */
export interface RestorePoint {
  driveFileId: string
  fileName: string
  /** Parsed out of the file name (`src/lib/driveSnapshot.ts`) rather than trusted from Drive's own metadata ordering. */
  takenAt: string | null
  sizeBytes: number | null
}

/** What `backup:runNow` resolves with, so the panel can report the outcome without a second round trip. */
export interface RunBackupResult {
  ok: boolean
  driveFileId: string | null
  fileName: string | null
  sizeBytes: number | null
  error: string | null
}
