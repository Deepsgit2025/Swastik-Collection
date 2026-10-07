// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { InvalidSnapshotError, assertValidSnapshot, preRestoreCopyPath, swapInSnapshot } from './restore.ts'
import { runMigrations } from '../../src/db/migrationRunner.ts'

/**
 * The restore path is the only thing in this app that deliberately destroys
 * data, so these are the tests that matter most in Phase 12.
 *
 * They run against real files on disk rather than mocks: the failure being
 * guarded against is "a file that was not a database got written over app.db",
 * and a mocked filesystem cannot demonstrate that it did not happen.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, '../../src/db/migrations')

let workDir: string

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swastik-restore-test-'))
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

/** A real, fully-migrated database with a row in it — what a genuine snapshot looks like. */
function makeRealDatabase(filePath: string, marker = 'Shop Owner'): void {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  runMigrations(db, MIGRATIONS_DIR)
  db.prepare('INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, ?, ?)').run(
    'owner',
    'x',
    'owner',
    marker,
  )
  db.close()
}

describe('assertValidSnapshot', () => {
  it('accepts a snapshot produced by the real online-backup API', async () => {
    const source = path.join(workDir, 'source.db')
    makeRealDatabase(source)

    // Exactly how runBackup takes its snapshot — db.backup(), not a file copy,
    // because a WAL database can hold its newest commits in the -wal sidecar
    // and not in the .db file at all.
    const live = new Database(source)
    const snapshot = path.join(workDir, 'snapshot.db')
    await live.backup(snapshot)
    live.close()

    expect(() => assertValidSnapshot(snapshot)).not.toThrow()
  })

  it('rejects a file that does not exist', () => {
    expect(() => assertValidSnapshot(path.join(workDir, 'nope.db'))).toThrow(InvalidSnapshotError)
  })

  it('rejects an empty file', () => {
    const empty = path.join(workDir, 'empty.db')
    fs.writeFileSync(empty, '')
    expect(() => assertValidSnapshot(empty)).toThrow(/empty/)
  })

  /**
   * A download interrupted halfway leaves a plausible-looking file with a valid
   * SQLite header and no usable content. Writing that over the shop database
   * would destroy it, and the damage would only surface on the next launch.
   */
  it('rejects a truncated database', () => {
    const source = path.join(workDir, 'source.db')
    makeRealDatabase(source)
    const truncated = path.join(workDir, 'truncated.db')
    fs.writeFileSync(truncated, fs.readFileSync(source).subarray(0, 200))

    expect(() => assertValidSnapshot(truncated)).toThrow(InvalidSnapshotError)
  })

  /** A captive portal page, or a Drive error body, saved under a .db name. */
  it('rejects an HTML error page', () => {
    const html = path.join(workDir, 'error.db')
    fs.writeFileSync(html, '<!doctype html><title>429 Too Many Requests</title>')
    expect(() => assertValidSnapshot(html)).toThrow(InvalidSnapshotError)
  })

  it('rejects random bytes', () => {
    const junk = path.join(workDir, 'junk.db')
    fs.writeFileSync(junk, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    expect(() => assertValidSnapshot(junk)).toThrow(InvalidSnapshotError)
  })

  /**
   * The case a bare "is it SQLite?" check would wave straight through: a
   * perfectly valid database that simply belongs to something else.
   */
  it('rejects a valid SQLite database belonging to something else', () => {
    const stranger = path.join(workDir, 'stranger.db')
    const other = new Database(stranger)
    other.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)')
    other.close()

    expect(() => assertValidSnapshot(stranger)).toThrow(/not a Swastik Collection backup/)
  })

  it('names the tables that were missing, so the reason is diagnosable', () => {
    const partial = path.join(workDir, 'partial.db')
    const db = new Database(partial)
    db.exec('CREATE TABLE _migrations (id INTEGER PRIMARY KEY, filename TEXT)')
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)')
    db.close()

    expect(() => assertValidSnapshot(partial)).toThrow(/sales/)
  })

  it('does not modify the file it validates', () => {
    const source = path.join(workDir, 'source.db')
    makeRealDatabase(source)
    const before = fs.readFileSync(source)

    assertValidSnapshot(source)

    expect(fs.readFileSync(source).equals(before)).toBe(true)
  })
})

describe('preRestoreCopyPath', () => {
  it('names the safety copy by the moment it was taken, so several stay tellable apart', () => {
    const first = preRestoreCopyPath(workDir, new Date(2026, 7, 26, 21, 0, 5))
    const second = preRestoreCopyPath(workDir, new Date(2026, 7, 26, 21, 30, 5))

    expect(path.basename(first).startsWith('app-pre-restore-')).toBe(true)
    expect(first.endsWith('.db')).toBe(true)
    expect(first).not.toBe(second)
  })
})

describe('swapInSnapshot', () => {
  it('replaces the live database and keeps the replaced one as a safety copy', () => {
    const livePath = path.join(workDir, 'app.db')
    const snapshotPath = path.join(workDir, 'snapshot.db')
    const safetyCopy = path.join(workDir, 'app-pre-restore.db')

    makeRealDatabase(livePath, 'Current Owner')
    makeRealDatabase(snapshotPath, 'Restored Owner')

    swapInSnapshot(livePath, snapshotPath, safetyCopy)

    const restored = new Database(livePath, { readonly: true })
    expect((restored.prepare('SELECT full_name AS n FROM users').get() as { n: string }).n).toBe('Restored Owner')
    restored.close()

    // The database that was replaced is still on disk — a wrong click is
    // recoverable rather than final.
    const kept = new Database(safetyCopy, { readonly: true })
    expect((kept.prepare('SELECT full_name AS n FROM users').get() as { n: string }).n).toBe('Current Owner')
    kept.close()
  })

  /**
   * The -wal and -shm files describe the database being replaced. Left beside a
   * different file they are a way to corrupt the restored one on its next open.
   */
  it('removes the stale WAL sidecars belonging to the replaced database', () => {
    const livePath = path.join(workDir, 'app.db')
    const snapshotPath = path.join(workDir, 'snapshot.db')
    makeRealDatabase(livePath)
    makeRealDatabase(snapshotPath)
    fs.writeFileSync(`${livePath}-wal`, 'stale')
    fs.writeFileSync(`${livePath}-shm`, 'stale')

    swapInSnapshot(livePath, snapshotPath, path.join(workDir, 'safety.db'))

    expect(fs.existsSync(`${livePath}-wal`)).toBe(false)
    expect(fs.existsSync(`${livePath}-shm`)).toBe(false)
  })

  it('still works on a first run where there is no live database to keep', () => {
    const livePath = path.join(workDir, 'app.db')
    const snapshotPath = path.join(workDir, 'snapshot.db')
    const safetyCopy = path.join(workDir, 'safety.db')
    makeRealDatabase(snapshotPath)

    expect(() => swapInSnapshot(livePath, snapshotPath, safetyCopy)).not.toThrow()
    expect(fs.existsSync(livePath)).toBe(true)
    expect(fs.existsSync(safetyCopy)).toBe(false)
  })
})

/**
 * A snapshot can predate the current schema. Restoring one has to leave a
 * database today's code can actually read — otherwise the app comes back up
 * querying columns that do not exist.
 */
describe('migrating a restored snapshot forward', () => {
  it('brings an older database up to the current schema', () => {
    const older = path.join(workDir, 'older.db')
    const db = new Database(older)
    // Only the first two migrations — a database from before Phase 12 existed.
    for (const file of ['001_init.sql', '002_core_schema.sql']) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'))
    }
    db.exec(
      'CREATE TABLE _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at TEXT)',
    )
    for (const file of ['001_init.sql', '002_core_schema.sql']) {
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file)
    }
    db.close()

    expect(() => assertValidSnapshot(older)).not.toThrow()

    const restored = new Database(older)
    runMigrations(restored, MIGRATIONS_DIR)

    // Phase 12 columns and seeded rows are present after the catch-up run.
    const backupColumns = (restored.pragma('table_info(backup_log)') as Array<{ name: string }>).map((c) => c.name)
    expect(backupColumns).toContain('error')
    const shopName = restored.prepare("SELECT value FROM settings WHERE key = 'shop_name'").get() as
      | { value: string }
      | undefined
    expect(shopName?.value).toBe('')
    restored.close()
  })
})
