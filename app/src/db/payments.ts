import type Database from 'better-sqlite3'
import type { PaymentRecord, RecordPaymentInput, RecordPaymentResult } from '../types/payment.ts'
import type { SafeUser } from '../types/user.ts'
import { assertPermission } from './permissions.ts'
import { adjustPartyBalance, getPartyById } from './parties.ts'
import { roundMoney } from '../lib/saleMath.ts'
import { validatePaymentAmount, validatePaymentMode, validatePaymentParty } from '../lib/paymentMath.ts'

const PAYMENT_COLUMNS = `id, party_id, amount, mode, note, recorded_by_user_id, created_at`

export function getPaymentById(db: Database.Database, id: number): PaymentRecord | null {
  const payment = db.prepare(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = ?`).get(id) as
    | PaymentRecord
    | undefined
  return payment ?? null
}

/**
 * Records a payment against a party's outstanding balance (PHASE8.md
 * section 2), independent of any sale.
 *
 * **Not WhatsApp-gated and no print step** — deliberately, per PHASE8.md
 * section 0 and the permanent rule in CLAUDE.md. Unlike `createSale`, this
 * function has no `sendSaleWhatsAppNotifications` counterpart and its IPC
 * handler does nothing after the write: recording is the whole flow. Don't
 * add a send or a print path here in a later phase without the client
 * changing that rule.
 *
 * The insert and the `adjustPartyBalance(-amount)` call run in one
 * `db.transaction`, same as `createSale`'s sale/items/balance write — a
 * payment row whose balance adjustment didn't land would silently overstate
 * what the party still owes.
 */
export function recordPayment(
  db: Database.Database,
  user: SafeUser,
  input: RecordPaymentInput,
): RecordPaymentResult {
  assertPermission(user.role, 'payment:create')

  const partyError = validatePaymentParty(input.partyId)
  if (partyError) throw new Error(partyError)

  const amount = roundMoney(input.amount)
  const amountError = validatePaymentAmount(amount)
  if (amountError) throw new Error(amountError)

  const modeError = validatePaymentMode(input.mode)
  if (modeError) throw new Error(modeError)

  if (!getPartyById(db, input.partyId)) {
    throw new Error(`Party ${input.partyId} not found`)
  }

  const insertPayment = db.prepare(
    `INSERT INTO payments (party_id, amount, mode, note, recorded_by_user_id) VALUES (?, ?, ?, ?, ?)`,
  )

  const run = db.transaction((): number => {
    const result = insertPayment.run(
      input.partyId,
      amount,
      input.mode,
      input.note?.trim() || null,
      user.id,
    )
    // Payments reduce what's owed (PHASE8.md section 2, step 3) — the same
    // cached-balance helper Phase 5 calls with `+creditAmount` on a credit
    // sale, reused rather than a second hand-written UPDATE.
    adjustPartyBalance(db, input.partyId, -amount)
    return result.lastInsertRowid as number
  })

  const paymentId = run()

  // Both re-read after the transaction so the caller gets the committed row
  // and the already-adjusted balance — step 4's "return the updated party
  // record so the UI can immediately reflect the new balance".
  return { payment: getPaymentById(db, paymentId)!, party: getPartyById(db, input.partyId)! }
}
