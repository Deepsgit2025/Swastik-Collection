import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import electron from 'electron'
// Imported as a value, not `import type`: the restore path opens the swapped-in
// file directly to migrate it, before anything reopens the app-wide connection.
import Database from 'better-sqlite3'
import { assertPermission } from '../../src/db/permissions.js'
import { getBackupLog, getLastSuccessfulBackup, recordBackupResult } from '../../src/db/backups.js'
import {
  clearDriveCredentials,
  getBackupSchedule,
  getDriveCredentials,
  setBackupSchedule,
  setDriveCredentials,
} from '../../src/db/settings.js'
import { closeDb, getDbPath, getMigrationsDir } from '../../src/db/db.js'
import { runMigrations } from '../../src/db/migrationRunner.js'
import { buildSnapshotFileName } from '../../src/lib/driveSnapshot.js'
import { isScheduledBackupDue, nextScheduledRun, shouldBackupOnClose } from '../../src/lib/backupSchedule.js'
import type { BackupSchedule, BackupStatusView, RestorePoint, RunBackupResult } from '../../src/types/backup.js'
import type { SafeUser } from '../../src/types/user.js'
import {
  type DriveCredentials,
  downloadSnapshot,
  ensureAppFolder,
  fetchAccountEmail,
  listSnapshots,
  refreshAccessToken,
  uploadSnapshot,
} from './googleDrive.js'
import { authorizeGoogleDrive } from './oauth.js'
import { clearDriveAuth, readDriveAuth, rememberFolderId, writeDriveAuth } from './tokenStore.js'
import { InvalidSnapshotError, assertValidSnapshot, preRestoreCopyPath, swapInSnapshot } from './restore.js'

const { app } = electron

/** How often the schedule is re-checked while the app is open. A shop that leaves the app running for days would never fire a launch-only check — the same reasoning PHASE12.md section 3 gives for the purge job. */
const SCHEDULE_POLL_MS = 15 * 60 * 1000

/**
 * Budget for the on-close backup.
 *
 * Closing the app can be slow; it must never be stuck. Past this, the attempt is
 * recorded as a failure with its reason and the app quits regardless — an
 * unreachable network at closing time is not a reason to trap someone in a
 * window that will not shut.
 */
const ON_CLOSE_TIMEOUT_MS = 8_000

let scheduleTimer: NodeJS.Timeout | null = null
/** Guards against a scheduled run and a manual click overlapping — two `db.backup()` calls to the same temp name would fight over the file. */
let backupInFlight = false

function credentialsOrThrow(db: Database.Database): DriveCredentials {
  const credentials = getDriveCredentials(db)
  if (!credentials.clientId || !credentials.clientSecret) {
    throw new Error('Add your Google OAuth Client ID and Secret in Settings before connecting Drive.')
  }
  return credentials
}

/** Whether a usable Drive authorization is stored on this machine. Read by the retention sweep, which must be able to tell "not connected" apart from "nothing to delete". */
export function isDriveConnected(): boolean {
  return readDriveAuth() != null
}

/**
 * A fresh access token for the stored authorization. Access tokens last an
 * hour; nothing here caches one, because a backup runs at most a few times a
 * day.
 *
 * Exported as `driveAccessToken` for the retention job (`electron/retention/`),
 * which needs the same authorization to sweep expired snapshots and has no
 * business rebuilding this.
 */
export async function driveAccessToken(db: Database.Database): Promise<string> {
  const auth = readDriveAuth()
  if (!auth) throw new Error('Google Drive is not connected. Connect it in Settings first.')
  return refreshAccessToken(credentialsOrThrow(db), auth.refreshToken)
}

/**
 * The app's Drive folder id, resolving and caching it on first use.
 *
 * Extracted because three callers now need it — a backup, the restore list, and
 * the retention sweep — and the first two had grown their own copies of the
 * same six lines.
 */
export async function driveFolderId(accessToken: string): Promise<string> {
  const cached = readDriveAuth()?.folderId
  if (cached) return cached
  const folderId = await ensureAppFolder(accessToken)
  rememberFolderId(folderId)
  return folderId
}

/**
 * Snapshots the database and pushes it to Drive (PHASE12.md section 2).
 *
 * **The snapshot goes through `db.backup()`, never a file copy.** The database
 * runs in WAL mode, so committed transactions can be sitting in `app.db-wal`
 * and entirely absent from `app.db` — copying the file yields a snapshot
 * silently missing the most recent sales, which are exactly the ones the
 * day-30 purge will later trust this backup to hold.
 *
 * **A `success` row is written only once Drive has returned a file id.** Never
 * before the upload, never during. `attemptSend` in `electron/whatsapp/send.ts`
 * documents at length what optimistic status writes cost there; here the cost
 * would be a purge job deleting local bills on the strength of a backup that
 * does not exist.
 *
 * Failures resolve rather than throw, so a scheduled run cannot take anything
 * down with it — the outcome is in the returned result and, more importantly,
 * in `backup_log` with its reason.
 */
export async function runBackup(
  db: Database.Database,
  user: SafeUser,
  triggeredBy: 'scheduled' | 'manual',
): Promise<RunBackupResult> {
  assertPermission(user.role, 'backup:run')

  if (backupInFlight) {
    return { ok: false, driveFileId: null, fileName: null, sizeBytes: null, error: 'A backup is already running.' }
  }
  backupInFlight = true

  const fileName = buildSnapshotFileName()
  const tempPath = path.join(os.tmpdir(), `swastik-${Date.now()}-${fileName}`)

  try {
    const accessToken = await driveAccessToken(db)

    // Online backup: consistent, WAL folded in, and safe to run while the shop
    // is mid-sale on the same connection.
    await db.backup(tempPath)

    let folderId = await driveFolderId(accessToken)

    let uploaded
    try {
      uploaded = await uploadSnapshot(accessToken, folderId, tempPath, fileName)
    } catch (err) {
      // The cached folder id may point at something the Owner has since deleted
      // or trashed in their Drive. Re-resolve once and retry before calling the
      // whole backup a failure — losing a night's snapshot because a folder was
      // tidied away would be a poor reason to fail.
      console.warn('[backup] upload failed; re-resolving the Drive folder and retrying once:', err)
      folderId = await ensureAppFolder(accessToken)
      rememberFolderId(folderId)
      uploaded = await uploadSnapshot(accessToken, folderId, tempPath, fileName)
    }

    recordBackupResult(db, {
      triggeredBy,
      driveFileId: uploaded.driveFileId,
      fileName,
      sizeBytes: uploaded.sizeBytes,
    })
    return { ok: true, driveFileId: uploaded.driveFileId, fileName, sizeBytes: uploaded.sizeBytes, error: null }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[backup] ${triggeredBy} backup failed:`, err)
    recordBackupResult(db, { triggeredBy, driveFileId: null, fileName, error: reason })
    return { ok: false, driveFileId: null, fileName, sizeBytes: null, error: reason }
  } finally {
    backupInFlight = false
    fs.rmSync(tempPath, { force: true })
  }
}

/**
 * The scheduler's own caller — there is no logged-in `SafeUser` on a timer, so
 * it synthesises the Owner it is acting for from the database.
 *
 * This is **not** a hole in the IPC identity rule (CLAUDE.md Tech conventions):
 * that rule is about never trusting a *renderer-supplied* role. Nothing outside
 * this process can reach this path — it is a main-process timer — and the
 * Owner it resolves comes from `users`, not from an argument.
 */
function schedulerUser(db: Database.Database): SafeUser | null {
  const row = db
    .prepare("SELECT id, username, full_name FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY id ASC LIMIT 1")
    .get() as { id: number; username: string; full_name: string } | undefined
  return row ? { ...row, role: 'owner' } : null
}

async function runScheduledBackupIfDue(db: Database.Database): Promise<void> {
  if (!readDriveAuth()) return // Not connected — nothing to do, and nothing worth logging every 15 minutes.

  const schedule = getBackupSchedule(db)
  const last = getLastSuccessfulBackup(db)
  if (!isScheduledBackupDue(last?.created_at ?? null, schedule.timeOfDay)) return

  const user = schedulerUser(db)
  if (!user) return

  console.log('[backup] scheduled backup is due — running now')
  await runBackup(db, user, 'scheduled')
}

/**
 * Starts the daily schedule: a check at launch, then every 15 minutes.
 *
 * The launch check is what makes a missed run **catch up** — see
 * `isScheduledBackupDue`. A machine switched off at 21:00 would otherwise
 * answer "not 21:00" at every check and the shop would go weeks without a
 * backup while the setting cheerfully said "daily".
 */
export function startBackupScheduler(db: Database.Database): void {
  if (scheduleTimer) return
  void runScheduledBackupIfDue(db).catch((err: unknown) => console.error('[backup] launch check failed:', err))
  scheduleTimer = setInterval(() => {
    void runScheduledBackupIfDue(db).catch((err: unknown) => console.error('[backup] scheduled check failed:', err))
  }, SCHEDULE_POLL_MS)
}

export function stopBackupScheduler(): void {
  if (scheduleTimer) clearInterval(scheduleTimer)
  scheduleTimer = null
}

/**
 * The best-effort push as the app closes.
 *
 * Skipped entirely when Drive isn't connected, when the setting is off, or when
 * a successful backup already landed inside `ON_CLOSE_SKIP_WINDOW_MS` — so
 * closing shortly after the daily run costs nothing, which is the common case.
 * Bounded by `ON_CLOSE_TIMEOUT_MS` so a dead network cannot hold the window
 * open: the timeout resolves, it does not hang.
 */
export async function runOnCloseBackupIfDue(db: Database.Database): Promise<void> {
  try {
    if (!readDriveAuth()) return
    if (!getBackupSchedule(db).onAppClose) return

    const last = getLastSuccessfulBackup(db)
    if (!shouldBackupOnClose(last?.created_at ?? null)) return

    const user = schedulerUser(db)
    if (!user) return

    console.log('[backup] running the on-close backup')
    await Promise.race([
      runBackup(db, user, 'scheduled'),
      new Promise<void>((resolve) => setTimeout(resolve, ON_CLOSE_TIMEOUT_MS)),
    ])
  } catch (err) {
    // Nothing about closing the app may fail loudly. The attempt itself already
    // recorded its own reason in backup_log if it got that far.
    console.error('[backup] the on-close backup did not complete:', err)
  }
}

/** Everything the Settings panel renders. Carries no token and no client secret — only whether a secret is on file. */
export function getBackupStatus(db: Database.Database, user: SafeUser): BackupStatusView {
  assertPermission(user.role, 'backup:view')

  const credentials = getDriveCredentials(db)
  const auth = readDriveAuth()
  const schedule = getBackupSchedule(db)
  const next = nextScheduledRun(schedule.timeOfDay)

  return {
    clientId: credentials.clientId,
    hasClientSecret: credentials.clientSecret.length > 0,
    connected: auth != null,
    connectedEmail: auth?.email ?? null,
    schedule,
    lastSuccessAt: getLastSuccessfulBackup(db)?.created_at ?? null,
    nextRunAt: next ? next.toISOString() : null,
    recentAttempts: getBackupLog(db, 10),
  }
}

export function saveDriveCredentials(
  db: Database.Database,
  user: SafeUser,
  input: { clientId: string; clientSecret: string },
): void {
  setDriveCredentials(db, user, input)
}

export function saveBackupSchedule(
  db: Database.Database,
  user: SafeUser,
  schedule: BackupSchedule,
): BackupSchedule {
  return setBackupSchedule(db, user, schedule)
}

/** Runs the consent flow and persists the resulting refresh token. Owner-only. */
export async function connectDrive(db: Database.Database, user: SafeUser): Promise<void> {
  assertPermission(user.role, 'backup:run')

  const credentials = credentialsOrThrow(db)
  const { refreshToken, accessToken } = await authorizeGoogleDrive(credentials)
  const email = accessToken ? await fetchAccountEmail(accessToken) : null
  // The folder is resolved on the first backup rather than here, so a connect
  // succeeds even if Drive is momentarily unhappy about creating a folder.
  writeDriveAuth({ refreshToken, email, folderId: null })
}

/**
 * Forgets this machine's authorization and the stored client.
 *
 * The grant still exists on Google's side until the Owner revokes it in their
 * account — the Settings copy says so rather than implying this app can undo
 * something it cannot.
 */
export function disconnectDrive(db: Database.Database, user: SafeUser): void {
  assertPermission(user.role, 'backup:run')
  clearDriveAuth()
  clearDriveCredentials(db, user)
}

export async function listRestorePoints(db: Database.Database, user: SafeUser): Promise<RestorePoint[]> {
  assertPermission(user.role, 'backup:view')

  const accessToken = await driveAccessToken(db)
  return listSnapshots(accessToken, await driveFolderId(accessToken))
}

/**
 * Rebuilds the local database from a chosen backup point (PHASE12.md section 2).
 *
 * The order is the whole safety story, and nothing destructive happens until
 * everything else has already succeeded:
 *
 *  1. download to a temp file;
 *  2. **validate** it is really this app's database (`restore.ts`) — a
 *     truncated download or an HTML error page must never reach `app.db`;
 *  3. close the connection (the file cannot be replaced while it is open on
 *     Windows, and swapping a WAL database under a live handle corrupts it);
 *  4. **copy the current database aside** before overwriting it, so a wrong
 *     click is recoverable rather than final;
 *  5. swap the file in and drop the stale `-wal`/`-shm`;
 *  6. **run migrations on the restored file** — a snapshot can predate the
 *     current schema, and restoring a pre-`009` database into today's code
 *     would otherwise leave the Settings screen reading columns that do not
 *     exist;
 *  7. relaunch.
 *
 * The renderer never continues against a restored database: every open screen
 * holds rows from the replaced one, so the app restarts rather than leaving the
 * Owner looking at records that are no longer there. The WhatsApp session is
 * untouched throughout — it lives in a separate process that owns no database.
 */
export async function restoreFromBackup(
  db: Database.Database,
  user: SafeUser,
  driveFileId: string,
): Promise<void> {
  assertPermission(user.role, 'backup:restore')

  const accessToken = await driveAccessToken(db)
  const dbPath = getDbPath()
  const tempPath = path.join(os.tmpdir(), `swastik-restore-${Date.now()}.db`)

  try {
    await downloadSnapshot(accessToken, driveFileId, tempPath)
    assertValidSnapshot(tempPath)

    const safetyCopy = preRestoreCopyPath(app.getPath('userData'))

    closeDb()
    swapInSnapshot(dbPath, tempPath, safetyCopy)

    // Catch the restored file up to the current schema before anything opens it
    // as the live database.
    const restored = new Database(dbPath)
    try {
      restored.pragma('journal_mode = WAL')
      runMigrations(restored, getMigrationsDir())
    } finally {
      restored.close()
    }

    console.log(`[backup] restored from ${driveFileId}; previous database kept at ${safetyCopy}`)
  } catch (err) {
    if (err instanceof InvalidSnapshotError) throw err
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    fs.rmSync(tempPath, { force: true })
  }

  // Deliberately after the try/finally: by here the swap has succeeded, and a
  // relaunch is the only honest way to show the restored data.
  app.relaunch()
  app.exit(0)
}
