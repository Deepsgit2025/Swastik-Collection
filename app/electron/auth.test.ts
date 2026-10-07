// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { hashSync } from 'bcryptjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MissingCounterUserError, getCounterUser, verifyOwnerPassword } from './auth.ts'
import { COUNTER_USERNAME, ensureCounterUser } from '../src/db/seed.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(fs.readFileSync(path.join(__dirname, '../src/db/migrations/001_init.sql'), 'utf-8'))

  const insert = db.prepare(
    `INSERT INTO users (username, password_hash, role, full_name, is_active) VALUES (?, ?, ?, ?, ?)`,
  )
  insert.run('owner', hashSync('owner123', 10), 'owner', 'Shop Owner', 1)
  // A salesman login as migration 012 leaves them: the row survives so old
  // sales still resolve, but it is deactivated and can never sign in again.
  insert.run('salesman1', hashSync('sales123', 10), 'salesman', 'Test Salesman', 0)
  insert.run('old_owner', hashSync('retired123', 10), 'owner', 'Retired Owner', 0)

  ensureCounterUser(db)
})

/**
 * The Owner password is the only lock in the app since 2026-08-27 — it stands
 * in front of Reports, Settings, the Drive restore and the retention purge —
 * so what this function will and will not accept is the whole of the access
 * model, not a detail of it.
 */
describe('verifyOwnerPassword', () => {
  it('accepts the Owner password and returns the role from the DB, not anything client-supplied', () => {
    expect(verifyOwnerPassword(db, 'owner123')).toEqual({
      id: expect.any(Number),
      username: 'owner',
      role: 'owner',
      full_name: 'Shop Owner',
    })
  })

  it('rejects a wrong password', () => {
    expect(verifyOwnerPassword(db, 'wrong-password')).toBeNull()
  })

  it('rejects an empty password rather than treating it as a match', () => {
    expect(verifyOwnerPassword(db, '')).toBeNull()
  })

  /**
   * The heart of it. A salesman row is still a `users` row with a real bcrypt
   * hash — migration 012 deactivates them but does not delete them, because
   * every sale that person made references the id. If this function matched on
   * password alone, an old salesman password would unlock the Owner's screens,
   * which is precisely the access this change was meant to remove.
   */
  it("refuses a salesman's password, even though the row and its hash still exist", () => {
    expect(verifyOwnerPassword(db, 'sales123')).toBeNull()
  })

  it('refuses a deactivated Owner login', () => {
    expect(verifyOwnerPassword(db, 'retired123')).toBeNull()
  })

  /**
   * The counter account's `password_hash` is the literal `'!'`, which is not a
   * valid bcrypt hash. Belt and braces on top of the role filter — this asserts
   * that the account every unauthenticated session runs as cannot itself be
   * authenticated as, however it is approached.
   */
  it('cannot be unlocked by the counter account under any password', () => {
    expect(verifyOwnerPassword(db, '!')).toBeNull()
    expect(verifyOwnerPassword(db, 'Counter')).toBeNull()
    expect(verifyOwnerPassword(db, COUNTER_USERNAME)).toBeNull()
  })

  it('finds the right Owner when the shop has had more than one', () => {
    db.prepare(
      `INSERT INTO users (username, password_hash, role, full_name, is_active) VALUES (?, ?, 'owner', ?, 1)`,
    ).run('owner2', hashSync('second123', 10), 'Second Owner')

    expect(verifyOwnerPassword(db, 'second123')).toMatchObject({ username: 'owner2' })
    expect(verifyOwnerPassword(db, 'owner123')).toMatchObject({ username: 'owner' })
  })
})

describe('getCounterUser', () => {
  it('resolves the reserved account every session starts as', () => {
    expect(getCounterUser(db)).toEqual({
      id: expect.any(Number),
      username: COUNTER_USERNAME,
      // `salesman`, deliberately: it is what makes the Phase 2 PERMISSIONS
      // table the definition of what an un-elevated window may do, with no
      // third role and no loosened entry.
      role: 'salesman',
      full_name: 'Counter',
    })
  })

  it('throws rather than inventing an identity when the account is missing', () => {
    const empty = new Database(':memory:')
    empty.exec(fs.readFileSync(path.join(__dirname, '../src/db/migrations/001_init.sql'), 'utf-8'))

    expect(() => getCounterUser(empty)).toThrow(MissingCounterUserError)
  })
})

/**
 * `ensureCounterUser` runs on every launch, so it has to be safe to call
 * against a database that already has the row — including one migration 012 has
 * just deactivated along with every other `role = 'salesman'` row.
 */
describe('ensureCounterUser', () => {
  it('is idempotent — a second call creates no second account', () => {
    ensureCounterUser(db)
    ensureCounterUser(db)

    const { count } = db
      .prepare('SELECT COUNT(*) AS count FROM users WHERE username = ?')
      .get(COUNTER_USERNAME) as { count: number }
    expect(count).toBe(1)
  })

  it('re-enables the account if a migration deactivated it', () => {
    db.prepare('UPDATE users SET is_active = 0 WHERE username = ?').run(COUNTER_USERNAME)

    ensureCounterUser(db)

    // Without this the app would have no session at all: every IPC call would
    // reject with "Not authenticated" and the till would be dead.
    expect(getCounterUser(db).username).toBe(COUNTER_USERNAME)
    const row = db.prepare('SELECT is_active FROM users WHERE username = ?').get(COUNTER_USERNAME) as {
      is_active: number
    }
    expect(row.is_active).toBe(1)
  })

  it('never stores a usable password on it', () => {
    const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(COUNTER_USERNAME) as {
      password_hash: string
    }
    // Not a bcrypt hash, so nothing can ever compare true against it.
    expect(row.password_hash).toBe('!')
  })
})
