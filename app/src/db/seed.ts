import { hashSync } from 'bcryptjs'
import type Database from 'better-sqlite3'

interface DevUser {
  username: string
  password: string
  role: 'owner' | 'salesman'
  full_name: string
}

// Only an Owner. The `salesman1` login that used to sit here was removed on
// 2026-08-27: a salesman no longer logs in at all, so seeding one would create
// an account nothing can use. Salesman *names* live in the `salesmen` table
// instead (src/db/salesmen.ts) and the Owner adds them from Settings.
const DEV_USERS: DevUser[] = [
  { username: 'owner', password: 'owner123', role: 'owner', full_name: 'Shop Owner' },
]

/**
 * Throwaway dev/test accounts. Real user management now lives on the Phase 12
 * Settings screen (`src/db/users.ts`) — this only exists so a fresh install has
 * something to log in with before an Owner has created anything.
 *
 * Only runs when `users` is empty, so it never overwrites real accounts an
 * Owner has since created, including any Salesman login added from Settings —
 * safe to call on every app launch alongside the migration runner.
 */
export function seedDevUsers(db: Database.Database): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
  if (count > 0) return

  const insert = db.prepare(
    'INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, ?, ?)',
  )

  const insertAll = db.transaction((users: DevUser[]) => {
    for (const u of users) {
      insert.run(u.username, hashSync(u.password, 10), u.role, u.full_name)
    }
  })
  insertAll(DEV_USERS)

  console.log('[seed] created dev accounts:')
  for (const u of DEV_USERS) {
    console.log(`[seed]   ${u.username} / ${u.password}  (${u.role})`)
  }
}

/**
 * The reserved account every unauthenticated session runs as (client decision,
 * 2026-08-27: "remove salesman login").
 *
 * With no login screen, something still has to answer "who is calling" for
 * every IPC handler — CLAUDE.md's rule that identity comes from a
 * main-process session, never a renderer argument, did not change and must
 * not. This row is that answer for the ordinary counter session, and the
 * Owner password gate swaps it for a real Owner for as long as an Owner-only
 * module is open.
 *
 * **Its role is `salesman` on purpose.** The Phase 2 PERMISSIONS table already
 * spells out exactly what a person at the counter may do — create a sale,
 * record a payment, quick-add a customer, log an expense, print labels — and
 * nothing else. Reusing that role means the permission layer needed no third
 * role, no new entries and no loosened ones: what the counter can do is
 * enforced by precisely the same table that has enforced it since Phase 2.
 *
 * `password_hash` is `'!'`, which is not a valid bcrypt hash and so can never
 * compare true against anything. Belt and braces on top of the fact that
 * `verifyOwnerPassword` (electron/auth.ts) only ever considers `role = 'owner'`
 * rows, so this account is not a login candidate in the first place.
 *
 * Called from `getDb()` **after** `seedDevUsers`, never from a migration: a
 * migration inserting a user would leave `users` non-empty on a fresh install,
 * and `seedDevUsers`' `COUNT(*) > 0` guard would then skip creating the Owner —
 * an app nobody could ever unlock.
 */
export const COUNTER_USERNAME = '__counter__'

export function ensureCounterUser(db: Database.Database): void {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(COUNTER_USERNAME) as
    | { id: number }
    | undefined

  if (existing) {
    // Migration 012 deactivates every `role = 'salesman'` row, this one
    // included when it runs on an install that already had it. Re-enabling here
    // rather than special-casing it in the migration keeps the invariant in one
    // place: this account is always usable, because without it the app has no
    // session at all.
    db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(existing.id)
    return
  }

  db.prepare("INSERT INTO users (username, password_hash, role, full_name) VALUES (?, '!', 'salesman', 'Counter')").run(
    COUNTER_USERNAME,
  )
}
