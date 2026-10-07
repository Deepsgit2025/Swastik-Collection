/**
 * A salesman as a *record* rather than a login (client decision, 2026-08-27).
 *
 * There is no `username`, no `password_hash` and no `role` here, and that
 * absence is the feature: a salesman cannot log in, so there is nothing to
 * authenticate and nothing to take away. What used to be a `users` row with
 * `role = 'salesman'` is now this — a name the operator picks on the bill so
 * the Owner can see who sold what. Access control moved entirely to the Owner
 * password gate (see `electron/auth.ts`).
 */
export interface SalesmanRow {
  id: number
  name: string
  /** SQLite has no boolean: 1 = offered in the sale screen's dropdown, 0 = retired. Never deleted — old sales still reference this row. */
  is_active: number
  /** The `users` row this was migrated from, or null for one the Owner added afterwards. Set only by migration 012's backfill. */
  legacy_user_id: number | null
  created_at: string
}

export interface SalesmanListFilters {
  /** Only salesmen still on the payroll. The sale screen's dropdown passes this; Settings does not, because it has to be able to re-enable someone. */
  activeOnly?: boolean
}
