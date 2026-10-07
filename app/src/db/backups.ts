import type Database from 'better-sqlite3'
import type { BackupLogRow, BackupTrigger } from '../types/backup.js'

/**
 * `backup_log` — the audit trail every backup attempt lands in (PHASE12.md
 * section 2), and the table PHASE12.md section 3's day-30 purge is required to
 * consult before it removes anything locally.
 *
 * **No `assertPermission` in this file.** Writing a log row is a system side
 * effect of an already-gated action (`backup:run` / `backup:restore`, asserted
 * in `electron/backup/service.ts`), not an action of its own — the same
 * reasoning `src/db/whatsappLog.ts` and `adjustPartyBalance` are built on. The
 * gate belongs on the thing the Owner clicked, not on the record of what
 * happened.
 *
 * Rows are written **after** an attempt resolves, never optimistically before
 * it. There is no `pending` state — `backup_log.status`'s CHECK allows only
 * `success` and `failed` — and that is the right shape here: a row that said
 * `success` before the bytes were confirmed in Drive would be a lie the purge
 * job later acts on. This is the same ordering lesson `attemptSend`
 * (`electron/whatsapp/send.ts`) documents at length, with higher stakes.
 */

const COLUMNS = 'id, status, drive_file_id, triggered_by, error, file_name, size_bytes, created_at'

export interface RecordBackupInput {
  triggeredBy: BackupTrigger
  /** Present on success, null on failure — the Drive file id is the proof the snapshot exists off this machine. */
  driveFileId?: string | null
  fileName?: string | null
  sizeBytes?: number | null
  /** Why a failure failed. See migration `010_backup_log_detail.sql` for why this is not optional in spirit. */
  error?: string | null
}

/**
 * Records one finished attempt. A `driveFileId` is what distinguishes the two
 * outcomes: callers pass one only once Drive has confirmed the upload and
 * handed an id back.
 */
export function recordBackupResult(db: Database.Database, input: RecordBackupInput): BackupLogRow {
  const status = input.driveFileId ? 'success' : 'failed'
  const id = db
    .prepare(
      `INSERT INTO backup_log (status, drive_file_id, triggered_by, error, file_name, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      status,
      input.driveFileId ?? null,
      input.triggeredBy,
      input.error ?? null,
      input.fileName ?? null,
      input.sizeBytes ?? null,
    ).lastInsertRowid as number

  return db.prepare(`SELECT ${COLUMNS} FROM backup_log WHERE id = ?`).get(id) as BackupLogRow
}

/**
 * The most recent attempts, newest first — what the Settings panel renders,
 * failure reasons included.
 *
 * Showing failures next to successes is the point: a backup feature whose
 * screen only ever says "Last backup: …" hides a run of quiet failures behind
 * one old success, and this project has already spent two debugging sessions on
 * exactly that shape of problem in the WhatsApp send path.
 */
export function getBackupLog(db: Database.Database, limit = 10): BackupLogRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM backup_log ORDER BY id DESC LIMIT ?`)
    .all(limit) as BackupLogRow[]
}

/**
 * The newest **successful** backup, or null if there has never been one.
 *
 * Three callers, which is why it is a query rather than a filter at each site:
 * the Settings panel's "Last backup" line, `isScheduledBackupDue`'s catch-up
 * check, and the on-close skip window. PHASE12.md section 3's purge safeguard
 * will need the same question asked per-sale (a success *after* that sale was
 * created), which is a sibling of this query, not this one widened.
 *
 * Ordered by `id`, not `created_at`: two attempts inside the same second are
 * ordinary for a manual click following a scheduled run, and `datetime('now')`
 * has one-second resolution, so the rowid is the only strict ordering available.
 */
export function getLastSuccessfulBackup(db: Database.Database): BackupLogRow | null {
  return (
    (db
      .prepare(`SELECT ${COLUMNS} FROM backup_log WHERE status = 'success' ORDER BY id DESC LIMIT 1`)
      .get() as BackupLogRow | undefined) ?? null
  )
}
