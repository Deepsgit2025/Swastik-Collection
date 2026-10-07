import { compareSync } from 'bcryptjs'
import type Database from 'better-sqlite3'
import type { SafeUser } from '../src/types/user.js'
import { COUNTER_USERNAME } from '../src/db/seed.js'

/**
 * Who the app is running as, now that nobody logs in (client decision,
 * 2026-08-27: "remove salesman login").
 *
 * There are exactly two answers, and both are resolved here in the main
 * process from the database — never from anything the renderer says:
 *
 *  - **The counter.** The reserved `__counter__` row (`ensureCounterUser`,
 *    src/db/seed.ts), established for every window at launch. Role `salesman`,
 *    so the Phase 2 PERMISSIONS table already says exactly what it may do.
 *  - **The Owner**, for as long as an Owner-only module is open. Reached by
 *    typing the Owner password, verified by `verifyOwnerPassword` below.
 *
 * **The permission model did not change — only what fills the session did.**
 * Every `assertPermission` call in `src/db/**` is untouched; the password gate
 * works by swapping the `SafeUser` the session holds, so a renderer that
 * skipped the prompt is still the counter and still gets a `PermissionError`.
 * That is the whole reason the gate is not just a React modal.
 */

interface UserRow {
  id: number
  username: string
  role: 'owner' | 'salesman'
  full_name: string
  is_active: number
  password_hash: string
}

/**
 * Checks a password against every active Owner account.
 *
 * Takes **no username**: there is one Owner and the prompt asks for a password
 * only, because it is typed many times a day at a counter with people watching
 * and a second field to fill is friction with nothing behind it. The loop is
 * over "every active owner" rather than "the owner" so a shop that has ever had
 * two Owner rows still works.
 *
 * Replaces `verifyLogin`, which took a username and matched any role. Both
 * halves of that are now wrong: there is no login form to type a username into,
 * and a `role = 'salesman'` row must never unlock anything — `__counter__` is
 * one of those, and it exists precisely so that unauthenticated work has an
 * identity, not so that it can be authenticated as.
 *
 * A miss still pays the bcrypt cost (`compareSync` against a real hash runs on
 * every candidate before the answer is known), so this leaks nothing by timing.
 */
export function verifyOwnerPassword(db: Database.Database, password: string): SafeUser | null {
  const owners = db
    .prepare("SELECT id, username, role, full_name, is_active, password_hash FROM users WHERE role = 'owner' AND is_active = 1")
    .all() as UserRow[]

  for (const row of owners) {
    if (compareSync(password, row.password_hash)) {
      return { id: row.id, username: row.username, role: row.role, full_name: row.full_name }
    }
  }

  return null
}

/** Thrown when the counter account is missing, which can only mean the database is not the one this app created. Distinct from "wrong password" — it is a fault, not a refusal. */
export class MissingCounterUserError extends Error {
  constructor() {
    super('The counter account is missing from this database.')
    this.name = 'MissingCounterUserError'
  }
}

/**
 * The session every window starts in and returns to when an Owner-only module
 * is left.
 *
 * Re-read from the database each time rather than cached in a module-level
 * variable, for the reason `findActiveUser` was written this way before it:
 * Phase 12's Drive restore replaces `app.db` wholesale, and a cached row from
 * the old file would keep naming an id that means something else afterwards.
 */
export function getCounterUser(db: Database.Database): SafeUser {
  const row = db
    .prepare('SELECT id, username, role, full_name, is_active FROM users WHERE username = ?')
    .get(COUNTER_USERNAME) as Omit<UserRow, 'password_hash'> | undefined

  if (!row) throw new MissingCounterUserError()

  return { id: row.id, username: row.username, role: row.role, full_name: row.full_name }
}
