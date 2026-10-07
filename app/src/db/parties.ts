import type Database from 'better-sqlite3'
import type {
  CreatePartyInput,
  LedgerEntry,
  LedgerEntryType,
  PartyDetail,
  PartyLedgerResult,
  PartyListFilters,
  PartyListRow,
  QuickAddPartyInput,
  UpdatePartyInput,
} from '../types/party.ts'
import type { SafeUser } from '../types/user.ts'
import { assertPermission } from './permissions.ts'

interface SaleRow {
  id: number
  credit_amount: number
  grand_total: number
  payment_mode: string
  created_at: string
}

interface PaymentRow {
  id: number
  amount: number
  mode: string
  created_at: string
}

/** Read side of the Parties module (PHASE3.md section 1). No permission check needed: both roles can view per the section 2 table. */
export function getParties(db: Database.Database, filters: PartyListFilters = {}): PartyListRow[] {
  const conditions: string[] = []
  const params: unknown[] = []

  const search = filters.search?.trim()
  if (search) {
    conditions.push('(name LIKE ? OR phone LIKE ?)')
    const term = `%${search}%`
    params.push(term, term)
  }

  if (filters.onlyWithBalanceDue) {
    conditions.push('balance != 0')
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  return db
    .prepare(
      `SELECT id, name, phone, balance, created_at FROM parties ${where} ORDER BY name COLLATE NOCASE ASC`,
    )
    .all(...params) as PartyListRow[]
}

/** Single row lookup shared by the ledger view and the write functions below. */
export function getPartyById(db: Database.Database, id: number): PartyDetail | null {
  const party = db
    .prepare('SELECT id, name, phone, address, balance, created_at FROM parties WHERE id = ?')
    .get(id) as PartyDetail | undefined
  return party ?? null
}

/**
 * Combines sales and payments linked to a party into one chronological,
 * running-balance ledger. Each entry carries two numbers: `amount`, the
 * signed delta applied to the running balance (a sale's `credit_amount` —
 * 0 for a fully cash/UPI sale — or a payment's amount negated, mirroring
 * the `adjustPartyBalance` rule in section 3), and `billAmount`, what was
 * actually billed/paid (a sale's `grand_total` or a payment's `amount`) —
 * the figure the ledger UI displays, since `amount` alone reads as ₹0 on
 * every fully-paid sale. Returns null if the party doesn't exist.
 */
export function getPartyLedger(db: Database.Database, partyId: number): PartyLedgerResult | null {
  const party = getPartyById(db, partyId)
  if (!party) return null

  const sales = db
    .prepare('SELECT id, credit_amount, grand_total, payment_mode, created_at FROM sales WHERE party_id = ?')
    .all(partyId) as SaleRow[]
  const payments = db
    .prepare('SELECT id, amount, mode, created_at FROM payments WHERE party_id = ?')
    .all(partyId) as PaymentRow[]

  interface RawEntry {
    type: LedgerEntryType
    id: number
    date: string
    description: string
    delta: number
    billAmount: number
  }

  const raw: RawEntry[] = [
    ...sales.map(
      (s): RawEntry => ({
        type: 'sale',
        id: s.id,
        date: s.created_at,
        description: `Sale #${s.id} (${s.payment_mode})`,
        delta: s.credit_amount,
        billAmount: s.grand_total,
      }),
    ),
    ...payments.map(
      (p): RawEntry => ({
        type: 'payment',
        id: p.id,
        date: p.created_at,
        description: `Payment received (${p.mode})`,
        delta: -p.amount,
        billAmount: p.amount,
      }),
    ),
  ]

  // Chronological by timestamp; same-timestamp ties broken deterministically
  // (sale before payment, then by id) so the view never re-orders on re-render.
  raw.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    if (a.type !== b.type) return a.type === 'sale' ? -1 : 1
    return a.id - b.id
  })

  let running = 0
  const entries: LedgerEntry[] = raw.map((r) => {
    running += r.delta
    return {
      type: r.type,
      id: r.id,
      date: r.date,
      description: r.description,
      amount: r.delta,
      billAmount: r.billAmount,
      runningBalance: running,
    }
  })

  return { party, entries }
}

/**
 * Owner-facing full form (PHASE3.md section 1: name, phone, address, opening
 * balance). `assertPermission` allows both roles here per Phase 2's table —
 * `party:create` is shared with `quickAddParty` — but the full-form screen
 * that calls this is never routed to for Salesman, so in practice only Owner
 * reaches it. Don't add a role check beyond `assertPermission` here; that
 * would duplicate a rule that belongs at the route/UI layer per section 2.
 */
export function createParty(db: Database.Database, user: SafeUser, data: CreatePartyInput): PartyDetail {
  assertPermission(user.role, 'party:create')

  const name = data.name.trim()
  if (!name) throw new Error('Party name is required')

  const result = db
    .prepare('INSERT INTO parties (name, phone, address, balance, created_by_user_id) VALUES (?, ?, ?, ?, ?)')
    .run(name, data.phone?.trim() || null, data.address?.trim() || null, data.openingBalance ?? 0, user.id)

  return getPartyById(db, result.lastInsertRowid as number)!
}

/**
 * Deliberately a distinct function from `createParty`, not a thin wrapper
 * around it — takes `QuickAddPartyInput` (name + phone only, no address/
 * balance parameter to even pass through), so the "Salesman only ever gets
 * name+phone" rule holds at the function signature, not just in the UI that
 * calls it (PHASE3.md section 2). Both roles are allowed to call this today;
 * only Salesman's UI path (the Phase 5 sale flow, not yet built) is
 * exclusively this function — Owner has the full form too.
 */
export function quickAddParty(db: Database.Database, user: SafeUser, data: QuickAddPartyInput): PartyDetail {
  assertPermission(user.role, 'party:create')

  const name = data.name.trim()
  if (!name) throw new Error('Party name is required')
  const phone = data.phone.trim()
  if (!phone) throw new Error('Phone is required')

  const result = db
    .prepare('INSERT INTO parties (name, phone, address, balance, created_by_user_id) VALUES (?, ?, NULL, 0, ?)')
    .run(name, phone, user.id)

  return getPartyById(db, result.lastInsertRowid as number)!
}

/** Owner-only (PHASE3.md section 2: `party:edit`). Throws `PermissionError` for Salesman before touching SQLite. */
export function updateParty(db: Database.Database, user: SafeUser, id: number, data: UpdatePartyInput): PartyDetail {
  assertPermission(user.role, 'party:edit')

  const existing = getPartyById(db, id)
  if (!existing) throw new Error(`Party ${id} not found`)

  const name = data.name.trim()
  if (!name) throw new Error('Party name is required')

  db.prepare(`UPDATE parties SET name = ?, phone = ?, address = ?, updated_at = datetime('now') WHERE id = ?`).run(
    name,
    data.phone?.trim() || null,
    data.address?.trim() || null,
    id,
  )

  return getPartyById(db, id)!
}

/** Owner-only (PHASE3.md section 2: `party:delete`). Throws `PermissionError` for Salesman before touching SQLite. */
export function deleteParty(db: Database.Database, user: SafeUser, id: number): void {
  assertPermission(user.role, 'party:delete')

  const existing = getPartyById(db, id)
  if (!existing) throw new Error(`Party ${id} not found`)

  db.prepare('DELETE FROM parties WHERE id = ?').run(id)
}

/**
 * Updates the cached `balance` column on `parties` by `delta`
 * (PHASE3.md section 3). Not wired to any UI in this phase — Phase 5 (Sale)
 * calls this with `+credit_amount` on a credit sale, and Phase 8
 * (Payment-In) calls it with `-amount` on a recorded payment. No
 * `assertPermission` check here: this isn't a user-facing action of its own,
 * it's an internal side effect of those two write paths, which enforce their
 * own permissions before calling in.
 */
export function adjustPartyBalance(db: Database.Database, partyId: number, delta: number): PartyDetail {
  const existing = getPartyById(db, partyId)
  if (!existing) throw new Error(`Party ${partyId} not found`)

  db.prepare(`UPDATE parties SET balance = balance + ?, updated_at = datetime('now') WHERE id = ?`).run(
    delta,
    partyId,
  )

  return getPartyById(db, partyId)!
}
