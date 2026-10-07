// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareSync, hashSync } from 'bcryptjs'
import * as usersModule from './users.ts'
import { changeOwnerPassword } from './users.ts'
import { verifyOwnerPassword } from '../../electron/auth.ts'
import { PermissionError } from './permissions.ts'
import type { SafeUser } from '../types/user.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
let owner: SafeUser
let counter: SafeUser

beforeEach(() => {
  db = new Database(':memory:')
  const migrationsDir = path.join(__dirname, 'migrations')
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf-8'))
  }

  const ownerId = db
    .prepare('INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, ?, ?)')
    .run('owner', hashSync('owner123', 10), 'owner', 'Shop Owner').lastInsertRowid as number
  const counterId = db
    .prepare('INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, ?, ?)')
    .run('__counter__', '!', 'salesman', 'Counter').lastInsertRowid as number

  owner = { id: ownerId, username: 'owner', role: 'owner', full_name: 'Shop Owner' }
  counter = { id: counterId, username: '__counter__', role: 'salesman', full_name: 'Counter' }
})

function storedHash(id: number): string {
  return (db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as { password_hash: string })
    .password_hash
}

/**
 * The Owner password became the only lock in the app on 2026-08-27, and it is
 * typed at a counter with staff and customers in earshot several times a day.
 * Being able to rotate it is part of that gate, not a nicety beside it.
 */
describe('changeOwnerPassword', () => {
  it('replaces the password so the old one stops working and the new one starts', () => {
    changeOwnerPassword(db, owner, 'owner123', 'brand-new-secret')

    expect(verifyOwnerPassword(db, 'owner123')).toBeNull()
    expect(verifyOwnerPassword(db, 'brand-new-secret')).toMatchObject({ username: 'owner' })
  })

  it('stores a bcrypt hash, never the plain password', () => {
    changeOwnerPassword(db, owner, 'owner123', 'brand-new-secret')

    const hash = storedHash(owner.id)
    expect(hash).not.toBe('brand-new-secret')
    expect(hash.startsWith('$2')).toBe(true)
    expect(compareSync('brand-new-secret', hash)).toBe(true)
  })

  it('never returns the hash to the caller', () => {
    expect(changeOwnerPassword(db, owner, 'owner123', 'brand-new-secret')).not.toHaveProperty(
      'password_hash',
    )
  })

  /**
   * The app now sits unlocked at the counter all day, so any moment the Owner
   * walks away from an open Settings screen would otherwise be a moment
   * somebody could set a new password and own the shop's data. Re-proving the
   * current one is what closes that, and it is the difference between this and
   * Phase 12's `resetUserPassword`.
   */
  it('refuses without the current password, leaving the existing one working', () => {
    expect(() => changeOwnerPassword(db, owner, 'not-the-password', 'brand-new-secret')).toThrow(
      /not the current password/i,
    )

    expect(verifyOwnerPassword(db, 'owner123')).toMatchObject({ username: 'owner' })
    expect(verifyOwnerPassword(db, 'brand-new-secret')).toBeNull()
  })

  it('rejects a too-short new password without changing the existing one', () => {
    const before = storedHash(owner.id)

    expect(() => changeOwnerPassword(db, owner, 'owner123', 'abc')).toThrow()
    expect(storedHash(owner.id)).toBe(before)
  })

  /** A "change" that changes nothing leaves the Owner believing they rotated a password they did not. */
  it('refuses a new password identical to the current one', () => {
    expect(() => changeOwnerPassword(db, owner, 'owner123', 'owner123')).toThrow(/same as the current/i)
  })

  /**
   * The counter session is what an un-unlocked window is, so this is the check
   * standing between "anyone at the till" and taking the shop's password. It is
   * `user:manage` doing the work, exactly as it did before the login was
   * removed — the permission layer did not change, only what fills the session.
   */
  it('rejects a counter session, even against its own row', () => {
    expect(() => changeOwnerPassword(db, counter, 'owner123', 'brand-new-secret')).toThrow(PermissionError)
    expect(() => changeOwnerPassword(db, counter, '!', 'brand-new-secret')).toThrow(PermissionError)
    expect(verifyOwnerPassword(db, 'owner123')).toMatchObject({ username: 'owner' })
  })

  /**
   * Which row is changed comes from the session-resolved caller, never from an
   * id an argument could name — so there is no shape of call that points this
   * at somebody else's account.
   */
  it('only ever changes the calling Owner’s own row', () => {
    const otherId = db
      .prepare('INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, ?, ?)')
      .run('owner2', hashSync('second123', 10), 'owner', 'Second Owner').lastInsertRowid as number
    const otherBefore = storedHash(otherId)

    changeOwnerPassword(db, owner, 'owner123', 'brand-new-secret')

    expect(storedHash(otherId)).toBe(otherBefore)
    expect(verifyOwnerPassword(db, 'second123')).toMatchObject({ username: 'owner2' })
  })
})

/**
 * A deliberate absence, pinned so a later phase cannot quietly add one: a
 * `users` row is referenced by every sale, payment and expense that person
 * recorded, so a delete would break or orphan all of it.
 *
 * The list shrank on 2026-08-27. `listUsers`, `createSalesmanUser`,
 * `setUserActive` and `resetUserPassword` administered **salesman logins**,
 * which no longer exist — a salesman is a row in `salesmen` with no username
 * and no password (see `salesmen.test.ts`). What is left is the one function
 * the password gate needs.
 */
describe('the module surface', () => {
  it('exports nothing but the Owner password change — and nothing that deletes a user', () => {
    expect(Object.keys(usersModule).sort()).toEqual(['changeOwnerPassword'])
  })
})
