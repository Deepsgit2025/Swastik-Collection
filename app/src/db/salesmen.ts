import type Database from 'better-sqlite3'
import type { SalesmanListFilters, SalesmanRow } from '../types/salesman.js'
import type { SafeUser } from '../types/user.js'
import { assertPermission } from './permissions.js'

/**
 * The people who make sales (client decision, 2026-08-27) — names only, no
 * logins.
 *
 * Replaces what Phase 12's `src/db/users.ts` used to do for Salesmen. The
 * difference that matters: creating a row here grants **no access to
 * anything**. A salesman cannot log in, so the question "what may this person
 * reach" no longer has a per-person answer — everything a salesman must not
 * see now sits behind the Owner password gate (`electron/auth.ts`), and
 * everything they must reach is open at the counter.
 *
 * **There is no delete function here, deliberately**, for the same reason
 * `src/db/users.ts` never had one: `sales.salesman_id` references these rows,
 * and removing one would either break that key or silently strip the
 * attribution off every bill that person ever rang up. Leaving the shop is
 * `setSalesmanActive(..., false)` — they stop appearing in the sale screen's
 * dropdown while every past sale still reports their name.
 */

const SALESMAN_COLUMNS = 'id, name, is_active, legacy_user_id, created_at'

const MAX_NAME_LENGTH = 60

/** Thrown rather than letting two identically-named salesmen quietly coexist — the sale screen's dropdown would then be unusable, since the two are indistinguishable in it. */
export class DuplicateSalesmanError extends Error {
  constructor(name: string) {
    super(`There is already a salesman called "${name}".`)
    this.name = 'DuplicateSalesmanError'
  }
}

function validateName(name: string): string | null {
  if (!name) return 'Salesman name is required.'
  if (name.length > MAX_NAME_LENGTH) return `Salesman name must be ${MAX_NAME_LENGTH} characters or fewer.`
  return null
}

function getSalesmanRow(db: Database.Database, id: number): SalesmanRow | null {
  return (
    (db.prepare(`SELECT ${SALESMAN_COLUMNS} FROM salesmen WHERE id = ?`).get(id) as SalesmanRow | undefined) ?? null
  )
}

/** Case-insensitively, ignoring one id (so renaming someone to their own name isn't a clash). */
function nameExists(db: Database.Database, name: string, exceptId?: number): boolean {
  return (
    db
      .prepare('SELECT 1 FROM salesmen WHERE name = ? COLLATE NOCASE AND id IS NOT ?')
      .get(name, exceptId ?? null) != null
  )
}

/**
 * Ungated beyond an actual session, like `getParties` and `getBarcodeLabels`:
 * the sale screen's Salesman dropdown is open at the counter, so the counter
 * has to be able to read this list. A list of first names is not shop data
 * worth a permission — the writes below are where the gate is.
 */
export function listSalesmen(db: Database.Database, filters: SalesmanListFilters = {}): SalesmanRow[] {
  const where = filters.activeOnly ? 'WHERE is_active = 1' : ''
  return db
    .prepare(`SELECT ${SALESMAN_COLUMNS} FROM salesmen ${where} ORDER BY name COLLATE NOCASE ASC`)
    .all() as SalesmanRow[]
}

/** Owner-only via `salesman:manage`. Duplicate names are refused rather than allowed to make the sale screen's dropdown ambiguous. */
export function createSalesman(db: Database.Database, user: SafeUser, name: string): SalesmanRow {
  assertPermission(user.role, 'salesman:manage')

  const trimmed = name.trim()
  const error = validateName(trimmed)
  if (error) throw new Error(error)
  if (nameExists(db, trimmed)) throw new DuplicateSalesmanError(trimmed)

  const id = db.prepare('INSERT INTO salesmen (name) VALUES (?)').run(trimmed).lastInsertRowid as number
  return getSalesmanRow(db, id)!
}

/**
 * Renaming is a real edit of history, not a cosmetic one: reports resolve a
 * bill's salesman by joining this row, so correcting a spelling here corrects
 * it on every past bill too. That is the intended behaviour — it is the same
 * person — but it is worth knowing before using rename to recycle a row for a
 * different employee, which would silently reattribute their predecessor's
 * sales. Add a new salesman for a new person.
 */
export function renameSalesman(db: Database.Database, user: SafeUser, id: number, name: string): SalesmanRow {
  assertPermission(user.role, 'salesman:manage')

  const trimmed = name.trim()
  const error = validateName(trimmed)
  if (error) throw new Error(error)

  const target = getSalesmanRow(db, id)
  if (!target) throw new Error(`Salesman ${id} no longer exists.`)
  if (nameExists(db, trimmed, id)) throw new DuplicateSalesmanError(trimmed)

  db.prepare('UPDATE salesmen SET name = ? WHERE id = ?').run(trimmed, id)
  return getSalesmanRow(db, id)!
}

/** Soft-disable/re-enable. **Never deletes** — see the file header. An inactive salesman drops out of the sale screen's dropdown while every past sale keeps reporting their name. */
export function setSalesmanActive(
  db: Database.Database,
  user: SafeUser,
  id: number,
  isActive: boolean,
): SalesmanRow {
  assertPermission(user.role, 'salesman:manage')

  const target = getSalesmanRow(db, id)
  if (!target) throw new Error(`Salesman ${id} no longer exists.`)

  db.prepare('UPDATE salesmen SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id)
  return getSalesmanRow(db, id)!
}

/** The sale screen's early check on a typed name, before anything is written. */
export function validateSalesmanName(name: string): string | null {
  return validateName(name.trim())
}

/**
 * Turns the name typed on the sale screen into a `salesmen.id`, creating the
 * salesman when the name is new (client decision, 2026-09-19: the box is free
 * text with suggestions, not a picker).
 *
 * **A deliberate, narrow carve-out from `salesman:manage`.** Creating a *name*
 * as a side effect of ringing up a sale is open to the counter, because that is
 * what typing a new name into the box means. Everything else about salesmen —
 * renaming one, switching one off — stays Owner-only behind the password. It is
 * called from `createSale`, which has already asserted `sale:create`, and it has
 * no `assertPermission` of its own for the same reason `adjustPartyBalance`
 * doesn't: it is a side effect of an action that was already gated.
 *
 * Matching is case-insensitive so "ramesh" reuses "Ramesh". A name that belongs
 * to a salesman the Owner switched off is **refused**, not silently switched
 * back on — re-enabling someone is the Owner's decision, not a side effect of a
 * keystroke at the counter.
 *
 * Returns null for a blank name (an unassigned sale is a legal outcome).
 */
export function resolveSalesmanForSale(db: Database.Database, rawName: string | null | undefined): number | null {
  const name = (rawName ?? '').trim()
  if (name === '') return null

  const error = validateName(name)
  if (error) throw new Error(error)

  const existing = db
    .prepare('SELECT id, is_active FROM salesmen WHERE name = ? COLLATE NOCASE')
    .get(name) as { id: number; is_active: number } | undefined
  if (existing) {
    if (!existing.is_active) {
      throw new Error(`"${name}" has been switched off in Settings. Ask the Owner to switch them back on, or leave this blank.`)
    }
    return existing.id
  }

  return db.prepare('INSERT INTO salesmen (name) VALUES (?)').run(name).lastInsertRowid as number
}

/** Whether `id` names a real salesman —`createSale`'s guard, mirroring its existing `getPartyById` check on `partyId`. */
export function salesmanExists(db: Database.Database, id: number): boolean {
  return db.prepare('SELECT 1 FROM salesmen WHERE id = ?').get(id) != null
}
