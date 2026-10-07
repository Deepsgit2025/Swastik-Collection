import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'

interface MigrationRow {
  filename: string
}

/**
 * Applies every *.sql file in `migrationsDir` that isn't already recorded in
 * `_migrations`, in filename order. Safe to call on every app launch: already
 * applied files are skipped, and each new file is applied + recorded in one
 * transaction so a mid-migration failure can't leave a partially-applied file
 * marked as done.
 *
 * Knows nothing about any specific migration's contents — new files just need
 * to sort after existing ones (the 001_/002_/003_ prefix convention).
 */
export function runMigrations(db: Database.Database, migrationsDir: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const applied = new Set(
    (db.prepare('SELECT filename FROM _migrations').all() as MigrationRow[]).map((row) => row.filename),
  )

  const pending = fs
    .readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith('.sql'))
    .sort()
    .filter((filename) => !applied.has(filename))

  const recordMigration = db.prepare('INSERT INTO _migrations (filename) VALUES (?)')

  for (const filename of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf-8')

    const applyMigration = db.transaction(() => {
      db.exec(sql)
      recordMigration.run(filename)
    })
    applyMigration()

    console.log(`[migrations] applied ${filename}`)
  }
}
