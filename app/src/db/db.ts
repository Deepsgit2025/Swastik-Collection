import path from 'node:path'
import electron from 'electron'
import Database from 'better-sqlite3'
import { runMigrations } from './migrationRunner.js'
import { ensureCounterUser, seedDevUsers } from './seed.js'

const { app } = electron

let db: Database.Database | null = null

/** Where `app.db` lives. Exported because the Phase 12 backup/restore path has to snapshot and replace that exact file, not merely query through the connection. */
export function getDbPath(): string {
  return path.join(app.getPath('userData'), 'app.db')
}

/** The migrations directory, resolved the same way for the normal launch path and for the post-restore catch-up run. */
export function getMigrationsDir(): string {
  return path.join(app.getAppPath(), 'src/db/migrations')
}

/** Lazily opens (and migrates) the single app-wide SQLite connection. Main-process only. */
export function getDb(): Database.Database {
  if (db) return db

  db = new Database(getDbPath())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db, getMigrationsDir())
  seedDevUsers(db)
  // After seeding, never from a migration — see `ensureCounterUser` for why
  // inserting this row earlier would stop a fresh install from getting an Owner.
  ensureCounterUser(db)

  return db
}

/**
 * Closes the connection so the underlying file can be replaced.
 *
 * Only the restore path needs this (`electron/backup/service.ts`): swapping
 * `app.db` out from under an open handle is how a WAL database gets corrupted,
 * and on Windows the file cannot be replaced at all while it is open. Nothing
 * else in the app should call this — the connection is meant to live as long as
 * the process, and the restore path quits immediately afterwards anyway.
 */
export function closeDb(): void {
  db?.close()
  db = null
}
