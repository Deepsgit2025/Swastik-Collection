import { compareSync, hashSync } from 'bcryptjs'
import type Database from 'better-sqlite3'
import type { SafeUser, UserListRow } from '../types/user.js'
import { assertPermission } from './permissions.js'
import { validatePassword } from '../lib/settingsValidation.js'

/**
 * What is left of user management after the salesman login was removed
 * (client decision, 2026-08-27).
 *
 * Phase 12 built this file to create, disable and reset **Salesman logins**.
 * All three are gone, because the thing they administered is gone: a salesman
 * is now a row in `salesmen` (src/db/salesmen.ts) with no username, no
 * password and no way into the app. Migration 012 deactivated the logins that
 * already existed; it did not delete them, so `sales.salesman_user_id`,
 * `payments.recorded_by_user_id`, `expenses.logged_by_user_id`,
 * `parties.created_by_user_id` and the print-override log all still resolve.
 *
 * **There is still deliberately no delete function here, and no delete IPC
 * channel anywhere**, for exactly the reason the Phase 12 version gave. That
 * absence is pinned by a test; do not add one without the client asking.
 *
 * What remains is one function, and it is new rather than a leftover. The
 * Owner password is now the *only* lock in the app — it stands in front of
 * Reports, Settings, the Drive restore and the purge job — and it is typed at
 * a counter with staff and customers in earshot. A password in that position
 * has to be rotatable.
 */

/**
 * Every column of `users` **except `password_hash`**. The hash must never
 * leave the main process — that is the whole reason password checking is
 * handled in `electron/auth.ts` rather than by shipping rows to the renderer
 * to compare. Pinned by a test.
 */
const USER_COLUMNS = 'id, username, full_name, role, is_active, created_at'

function getUserRow(db: Database.Database, id: number): UserListRow | null {
  return (db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as UserListRow | undefined) ?? null
}

/**
 * Changes the Owner's own password.
 *
 * **The current password is required**, and that is the difference between
 * this and Phase 12's `resetUserPassword` — which deliberately refused Owner
 * rows precisely because it had no such check. It matters more now, not less:
 * the app sits unlocked at the counter all day, so any moment the Owner steps
 * away from an open Settings screen is a moment somebody could otherwise set a
 * new password and own the shop's data. Re-proving the old one closes that.
 *
 * Which Owner is changed comes from `user`, the session-resolved caller, never
 * from an id the renderer supplies — there is no way to point this at somebody
 * else's row.
 *
 * `user:manage` was already Owner-only in the Phase 2 PERMISSIONS table, so no
 * new Action was needed.
 */
export function changeOwnerPassword(
  db: Database.Database,
  user: SafeUser,
  currentPassword: string,
  newPassword: string,
): UserListRow {
  assertPermission(user.role, 'user:manage')

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as
    | { password_hash: string }
    | undefined
  if (!row) throw new Error('This account no longer exists.')

  if (!compareSync(currentPassword, row.password_hash)) {
    throw new Error('That is not the current password.')
  }

  const error = validatePassword(newPassword)
  if (error) throw new Error(error)

  // Refused rather than silently accepted: a "change" that changes nothing
  // leaves the Owner believing they have rotated a password they have not.
  if (compareSync(newPassword, row.password_hash)) {
    throw new Error('The new password is the same as the current one.')
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashSync(newPassword, 10), user.id)
  return getUserRow(db, user.id)!
}
