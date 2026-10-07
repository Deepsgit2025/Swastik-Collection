import type Database from 'better-sqlite3'
import type { CreditRetentionCandidate, PurgeAction, PurgeLogRow, RetentionCandidate } from '../types/retention.js'
import { RETENTION_LOCAL_DAYS, RETENTION_TOTAL_DAYS } from '../lib/retention.js'

/**
 * The queries behind PHASE12.md section 3's retention job — including the
 * safeguard, which is the single most important predicate in this codebase.
 *
 * **No `assertPermission` in this file.** The gate is `retention:run`, asserted
 * in `electron/retention/service.ts` on the action the Owner actually took —
 * the same split `whatsappLog.ts` and `backups.ts` already follow. These
 * functions are also called by the read-only preview, which must be able to
 * answer "what would happen" without being a write path at all.
 *
 * **Times compare in UTC here, deliberately, and unlike `src/db/reports.ts`.**
 * Both `sales.created_at` and `backup_log.created_at` are written by
 * `datetime('now')`, so they compare directly against each other and against
 * `datetime('now', '-30 days')` with no conversion. The IST 5.5-hour offset
 * shifts a 30-day boundary by a few hours in one direction or the other, which
 * costs nothing either way — a bill purged five hours late is fine, and one
 * purged five hours early is still fully backed up because the safeguard, not
 * the clock, is what protects it. That is a genuinely different situation from
 * `reports.ts`, where the same offset moved a sale onto the wrong *day* and
 * changed a number the Owner would act on.
 */

const PURGE_LOG_COLUMNS = 'id, action, sale_id, sale_created_at, drive_file_id, file_name, created_at'

/** Old enough to be purged: a cash bill, past the local window. Credit sales are excluded here and nowhere else needs to remember it. */
const OLD_CASH_BILL = `
  s.is_cash_bill = 1
  AND datetime(s.created_at) <= datetime('now', '-${RETENTION_LOCAL_DAYS} days')`

/**
 * **The safeguard** (PHASE12.md section 3, "Required Safeguard").
 *
 * A successful backup that ran *after* this sale was created is the only proof
 * the sale exists somewhere other than this machine. Two details carry the
 * whole weight:
 *
 *  - `status = 'success'` — Prompt 2 writes that status only once Drive has
 *    returned a file id, never optimistically, so it means the bytes landed
 *    rather than that an attempt was made.
 *  - `b.created_at > s.created_at` — a backup taken *before* the sale existed
 *    cannot contain it. Without this the job would happily delete a bill on
 *    the strength of a snapshot that never held it, which is the exact "actual
 *    data loss earlier than the client intends" the safeguard exists to stop.
 */
const HAS_BEEN_BACKED_UP = `
  EXISTS (
    SELECT 1 FROM backup_log b
     WHERE b.status = 'success'
       AND b.created_at > s.created_at
  )`

/** Cash bills past day 30 that a successful backup has captured — safe to remove locally. */
export function findCashBillsDueForLocalPurge(db: Database.Database): RetentionCandidate[] {
  return db
    .prepare(
      `SELECT s.id, s.created_at, s.purge_at
         FROM sales s
        WHERE ${OLD_CASH_BILL}
          AND ${HAS_BEEN_BACKED_UP}
        ORDER BY s.id ASC`,
    )
    .all() as RetentionCandidate[]
}

/**
 * Cash bills past day 30 that **no** successful backup has captured.
 *
 * These are deliberately left alone, and deliberately surfaced. A number here
 * that keeps climbing is the safeguard working correctly *and* a shop one disk
 * failure away from losing those bills — so it belongs on the Owner's screen,
 * not only in a count nobody reads.
 */
export function findCashBillsHeldBack(db: Database.Database): RetentionCandidate[] {
  return db
    .prepare(
      `SELECT s.id, s.created_at, s.purge_at
         FROM sales s
        WHERE ${OLD_CASH_BILL}
          AND NOT ${HAS_BEEN_BACKED_UP}
        ORDER BY s.id ASC`,
    )
    .all() as RetentionCandidate[]
}

/**
 * Held-back bills that are also past their final day (`RETENTION_TOTAL_DAYS`).
 *
 * Computed from `created_at` rather than the stored `purge_at`: bills written
 * before the 30/60/90 rule became 30/30 carry a `purge_at` 90 days out, and
 * trusting it would report those late.
 *
 * **These are still not deleted.** The rule says the last day is the end, but the
 * safeguard says never destroy the only copy — and when those two disagree,
 * the safeguard wins. Deleting a bill that has never been backed up, purely
 * because a date passed, would be the worst possible reading of a rule whose
 * own section warns against causing data loss earlier than the client intends.
 * Reaching this list means Drive backups have been failing for months, which is
 * a problem to show the Owner, not to resolve by deleting their records.
 */
export function findOverdueNeverBackedUp(db: Database.Database): RetentionCandidate[] {
  return db
    .prepare(
      `SELECT s.id, s.created_at, s.purge_at
         FROM sales s
        WHERE ${OLD_CASH_BILL}
          AND NOT ${HAS_BEEN_BACKED_UP}
          AND datetime(s.created_at) <= datetime('now', '-${RETENTION_TOTAL_DAYS} days')
        ORDER BY s.id ASC`,
    )
    .all() as RetentionCandidate[]
}

/**
 * Removes one cash bill from local storage, permanently.
 *
 * A **hard delete**, not a flag. The rule says the bill "exists only in the
 * Google Drive backup, not locally", and a flagged row is still on the machine.
 * It also makes every existing reader correct for free: six places query
 * `sales` (`parties.ts`, three in `reports.ts`, `sales.ts`, two in
 * `whatsappLog.ts`) and a deleted row is invisible to all of them, with no
 * filter to add now and none for a future query to forget. `sales.archived_local`
 * is left in the schema unused and superseded by this.
 *
 * **`whatsapp_log` rows must go first.** `whatsapp_log.sale_id` references
 * `sales(id)` with no `ON DELETE CASCADE`, and `db.ts` sets
 * `foreign_keys = ON`, so deleting the sale first fails outright.
 * `sale_items` does cascade, so it needs nothing.
 *
 * One transaction: a bill whose items survived it, or whose audit line did not,
 * would be a worse state than either "gone" or "still here".
 *
 * Safe by construction for balances: a cash bill has `credit_amount = 0`, and
 * `getPartyLedger` derives its ledger delta from `credit_amount`, so removing
 * one cannot move a party's balance or alter their running ledger.
 */
export function purgeSaleLocally(db: Database.Database, sale: RetentionCandidate): void {
  db.transaction(() => {
    db.prepare('DELETE FROM whatsapp_log WHERE sale_id = ?').run(sale.id)
    db.prepare('DELETE FROM sales WHERE id = ?').run(sale.id)
    recordPurge(db, { action: 'local_purge', saleId: sale.id, saleCreatedAt: sale.created_at })
  })()
}

/**
 * **Credit bills** (client decision, 2026-09-19): kept for as long as they are
 * owed, then gone 60 days after the customer clears them — 30 days here, 30
 * more in Drive only, the same two windows a cash bill gets.
 *
 * "Cleared" is a fact about the *party*, not about a bill: payments in this app
 * are not allocated to individual bills, so the only honest question is "does
 * this party owe anything?". A party qualifies when:
 *
 *  - `ROUND(balance, 2) = 0` **exactly**. `!= 0` would carry float residue as
 *    "owing" (see `getPartyOutstandingList`), and `> 0` would sweep in a party
 *    holding an advance — whose payments are the only record of that advance,
 *    so they are never touched.
 *  - it has at least one credit bill (otherwise there is nothing to purge), and
 *  - its **last activity** — the newest credit bill or payment it has — is at
 *    least `RETENTION_LOCAL_DAYS` old. That date is when the balance last
 *    reached zero; any later credit sale or payment moves it, so a customer who
 *    borrows again is never purged early. Cash bills are ignored here: they
 *    carry no credit and follow the cash rule on their own.
 */
const SETTLED_CREDIT_PARTIES = `
  SELECT p.id AS party_id,
         MAX(
           COALESCE((SELECT MAX(datetime(c.created_at)) FROM sales c WHERE c.party_id = p.id AND c.is_cash_bill = 0), ''),
           COALESCE((SELECT MAX(datetime(pm.created_at)) FROM payments pm WHERE pm.party_id = p.id), '')
         ) AS last_activity
    FROM parties p
   WHERE ROUND(p.balance, 2) = 0
     AND EXISTS (SELECT 1 FROM sales c WHERE c.party_id = p.id AND c.is_cash_bill = 0)`

/**
 * The safeguard for a credit party: a successful backup taken *after* its last
 * activity is the proof that every bill and payment about to be removed exists
 * somewhere other than this machine. Same two details as `HAS_BEEN_BACKED_UP`.
 */
const CREDIT_PARTY_BACKED_UP = `
  EXISTS (
    SELECT 1 FROM backup_log b
     WHERE b.status = 'success'
       AND datetime(b.created_at) > st.last_activity
  )`

const CREDIT_PARTY_OLD_ENOUGH = `st.last_activity <= datetime('now', '-${RETENTION_LOCAL_DAYS} days')`

function creditCandidates(db: Database.Database, backedUp: boolean): CreditRetentionCandidate[] {
  return db
    .prepare(
      `WITH st AS (${SETTLED_CREDIT_PARTIES}
        GROUP BY p.id)
       SELECT s.id, s.created_at, s.purge_at, s.party_id
         FROM sales s
         JOIN st ON st.party_id = s.party_id
        WHERE s.is_cash_bill = 0
          AND ${CREDIT_PARTY_OLD_ENOUGH}
          AND ${backedUp ? '' : 'NOT'} ${CREDIT_PARTY_BACKED_UP}
        ORDER BY s.id ASC`,
    )
    .all() as CreditRetentionCandidate[]
}

/** Credit bills of settled parties, 30+ days after the last activity, that a backup has captured — safe to remove locally. */
export function findSettledCreditDueForLocalPurge(db: Database.Database): CreditRetentionCandidate[] {
  return creditCandidates(db, true)
}

/** The same bills with **no** backup after the party's last activity — deliberately left alone, and shown, exactly like `findCashBillsHeldBack`. */
export function findSettledCreditHeldBack(db: Database.Database): CreditRetentionCandidate[] {
  return creditCandidates(db, false)
}

/**
 * Removes every credit bill of one settled party, **and that party's payments**,
 * in a single transaction.
 *
 * The payments go with the bills on purpose. A party at exactly zero has, by
 * definition, paid what it owed, so the two sides cancel; deleting only the
 * bills would leave a ledger of payments with nothing to pay against and a
 * running balance that goes negative. Removing both keeps the ledger consistent
 * (a test pins that), and the party row and its `balance` are untouched.
 *
 * Callers pass the candidates the queries above returned, so the safeguard has
 * already run; this function trusts them and only re-checks the one thing that
 * could have changed in between — that the party is still at zero.
 *
 * `whatsapp_log` first, for the foreign key `purgeSaleLocally` documents;
 * `sale_items` cascade. One `purge_log` line per bill, none for payments —
 * a payment has no id anyone would ask about, and the line holds no money.
 * Returns how many bills were removed.
 */
export function purgeSettledCreditParty(db: Database.Database, partyId: number, sales: RetentionCandidate[]): number {
  return db.transaction((): number => {
    const stillSettled = db.prepare('SELECT 1 FROM parties WHERE id = ? AND ROUND(balance, 2) = 0').get(partyId)
    if (!stillSettled) return 0

    for (const sale of sales) {
      db.prepare('DELETE FROM whatsapp_log WHERE sale_id = ?').run(sale.id)
      db.prepare('DELETE FROM sales WHERE id = ? AND party_id = ? AND is_cash_bill = 0').run(sale.id, partyId)
      recordPurge(db, { action: 'local_purge', saleId: sale.id, saleCreatedAt: sale.created_at })
    }
    db.prepare('DELETE FROM payments WHERE party_id = ?').run(partyId)
    return sales.length
  })()
}

export interface RecordPurgeInput {
  action: PurgeAction
  saleId?: number | null
  saleCreatedAt?: string | null
  driveFileId?: string | null
  fileName?: string | null
}

/** Writes one audit line. Holds no money and no customer — see migration `011_purge_log.sql`. */
export function recordPurge(db: Database.Database, input: RecordPurgeInput): void {
  db.prepare(
    `INSERT INTO purge_log (action, sale_id, sale_created_at, drive_file_id, file_name)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.action,
    input.saleId ?? null,
    input.saleCreatedAt ?? null,
    input.driveFileId ?? null,
    input.fileName ?? null,
  )
}

/** The recent audit trail, newest first — what the Owner sees when they ask where a bill went. */
export function getPurgeLog(db: Database.Database, limit = 20): PurgeLogRow[] {
  return db
    .prepare(`SELECT ${PURGE_LOG_COLUMNS} FROM purge_log ORDER BY id DESC LIMIT ?`)
    .all(limit) as PurgeLogRow[]
}

/**
 * Whether anything has actually been purged yet.
 *
 * Drives the Reports note: the warning about thinned-out cash figures should
 * appear because bills really are gone, not merely because the feature exists.
 * A shop that has never enabled retention should never see it.
 */
export function hasPurgedAnyBill(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM purge_log WHERE action = 'local_purge' LIMIT 1").get() != null
}
