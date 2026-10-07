// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBackupLog, getLastSuccessfulBackup, recordBackupResult } from './backups.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations/001_init.sql'), 'utf-8'))
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations/002_core_schema.sql'), 'utf-8'))
  db.exec(fs.readFileSync(path.join(__dirname, 'migrations/010_backup_log_detail.sql'), 'utf-8'))
})

describe('recordBackupResult', () => {
  it('records a success once Drive has returned a file id', () => {
    const row = recordBackupResult(db, {
      triggeredBy: 'manual',
      driveFileId: 'drive-abc',
      fileName: 'swastik-backup-2026-08-26-2100.db',
      sizeBytes: 81920,
    })

    expect(row.status).toBe('success')
    expect(row.drive_file_id).toBe('drive-abc')
    expect(row.triggered_by).toBe('manual')
    expect(row.size_bytes).toBe(81920)
    expect(row.error).toBeNull()
  })

  /**
   * The whole reason migration 010 adds `error`. A failed backup that does not
   * say why is the mistake this project already made once in the WhatsApp send
   * path, where it cost two debugging passes and a direct database read.
   */
  it('records a failure with its reason', () => {
    const row = recordBackupResult(db, {
      triggeredBy: 'scheduled',
      error: 'Uploading the backup to Drive failed (HTTP 403): Rate Limit Exceeded',
      fileName: 'swastik-backup-2026-08-26-2100.db',
    })

    expect(row.status).toBe('failed')
    expect(row.drive_file_id).toBeNull()
    expect(row.error).toContain('Rate Limit Exceeded')
  })

  /**
   * A row is a success only when there is a Drive file id to point at. This is
   * the property PHASE12.md section 3's day-30 purge will act on, so "we tried"
   * must never be able to read as "it is safely off this machine".
   */
  it('is the file id, not the caller, that decides the status', () => {
    expect(recordBackupResult(db, { triggeredBy: 'manual' }).status).toBe('failed')
    expect(recordBackupResult(db, { triggeredBy: 'manual', driveFileId: 'x' }).status).toBe('success')
  })
})

describe('getBackupLog', () => {
  it('returns attempts newest first, failures included', () => {
    recordBackupResult(db, { triggeredBy: 'scheduled', driveFileId: 'one' })
    recordBackupResult(db, { triggeredBy: 'manual', error: 'network unreachable' })
    recordBackupResult(db, { triggeredBy: 'scheduled', driveFileId: 'three' })

    const rows = getBackupLog(db)
    expect(rows.map((row) => row.drive_file_id)).toEqual(['three', null, 'one'])
  })

  it('honours the limit', () => {
    for (let i = 0; i < 15; i++) recordBackupResult(db, { triggeredBy: 'scheduled', driveFileId: `f${i}` })
    expect(getBackupLog(db, 5)).toHaveLength(5)
  })
})

describe('getLastSuccessfulBackup', () => {
  it('is null before anything has ever succeeded', () => {
    expect(getLastSuccessfulBackup(db)).toBeNull()
  })

  /**
   * The one that matters for the schedule: a failure after a success must not
   * look like a more recent backup, or the catch-up check would decide the day
   * was covered by an upload that never happened.
   */
  it('ignores failures, however recent', () => {
    recordBackupResult(db, { triggeredBy: 'scheduled', driveFileId: 'the-real-one' })
    recordBackupResult(db, { triggeredBy: 'manual', error: 'network unreachable' })

    expect(getLastSuccessfulBackup(db)?.drive_file_id).toBe('the-real-one')
  })

  /**
   * `datetime('now')` has one-second resolution, and a manual click right after
   * a scheduled run lands in the same second — so ordering by timestamp alone
   * would be a coin toss. The rowid is the only strict order available.
   */
  it('picks the later of two successes written in the same second', () => {
    recordBackupResult(db, { triggeredBy: 'scheduled', driveFileId: 'earlier' })
    recordBackupResult(db, { triggeredBy: 'manual', driveFileId: 'later' })

    const rows = getBackupLog(db)
    expect(rows[0].created_at).toBe(rows[1].created_at)
    expect(getLastSuccessfulBackup(db)?.drive_file_id).toBe('later')
  })
})
