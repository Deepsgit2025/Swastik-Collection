import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/**
 * The checks that stand between a downloaded file and the shop's live database.
 *
 * Split out of `service.ts` — which needs a real Electron process to import —
 * precisely because this is the part that must never be wrong, and therefore
 * the part that has to be testable. `restore.test.ts` drives every function
 * here against real files on disk.
 *
 * The ordering rule the whole restore path is built on: **nothing destructive
 * happens until everything non-destructive has succeeded.** Download, then
 * validate, then copy the current database aside, and only then replace it.
 */

/** Thrown when a downloaded file is not something that may be allowed near `app.db`. A distinct type so the IPC layer can report it as a bad backup rather than a fault in the app. */
export class InvalidSnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSnapshotError'
  }
}

/**
 * Tables a file must contain to be this app's database rather than merely a
 * valid SQLite file. `_migrations` is the decisive one — it is this project's
 * own bookkeeping table and nothing else creates it — with two core tables
 * alongside it so a stripped-down or half-written file is caught too.
 */
const REQUIRED_TABLES = ['_migrations', 'users', 'sales']

/**
 * Confirms `filePath` is a readable SQLite database belonging to this app.
 *
 * This is the check that makes a restore survivable. Without it, a truncated
 * download, a captive-portal HTML page saved as `.db`, or a Drive error body
 * would all be written straight over the shop's live data — and the failure
 * would only surface on the next launch, after the original was gone.
 *
 * Opened **read-only**: verifying a file must not be able to modify it, and a
 * read-write open of a corrupt file can rewrite its header.
 */
export function assertValidSnapshot(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new InvalidSnapshotError('The downloaded backup file is missing.')
  }
  if (fs.statSync(filePath).size === 0) {
    throw new InvalidSnapshotError('The downloaded backup file is empty.')
  }

  let db: Database.Database | null = null
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true })
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name)

    const missing = REQUIRED_TABLES.filter((table) => !names.includes(table))
    if (missing.length > 0) {
      throw new InvalidSnapshotError(
        `That file is not a Swastik Collection backup — it is missing: ${missing.join(', ')}.`,
      )
    }
  } catch (err) {
    if (err instanceof InvalidSnapshotError) throw err
    // better-sqlite3 raises "file is not a database" for anything that isn't
    // one; anything else here is equally disqualifying.
    throw new InvalidSnapshotError(
      `That file could not be opened as a database: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    db?.close()
  }
}

/** Where the pre-restore safety copy of the current database goes. Named by the moment it was taken so several of them stay tellable apart. */
export function preRestoreCopyPath(userDataPath: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return path.join(userDataPath, `app-pre-restore-${stamp}.db`)
}

/**
 * Replaces the live database file with a validated snapshot.
 *
 * Call **only** after `assertValidSnapshot` has passed and the connection is
 * closed (`closeDb`). Two details that are not optional:
 *
 * - The stale `-wal` and `-shm` files are removed. They describe the database
 *   being replaced, and leaving them beside a different file is a way to
 *   corrupt the restored one on the next open.
 * - The safety copy is taken with a plain `copyFileSync` of the already-closed
 *   file, which is safe precisely *because* the connection is closed — the
 *   WAL has been checkpointed and folded in by `close()`. (While a connection
 *   is open, `db.backup()` is the only correct way to copy this database; see
 *   `runBackup`.)
 */
export function swapInSnapshot(dbPath: string, snapshotPath: string, safetyCopyPath: string): void {
  if (fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, safetyCopyPath)
  }

  fs.copyFileSync(snapshotPath, dbPath)

  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    fs.rmSync(sidecar, { force: true })
  }
}
