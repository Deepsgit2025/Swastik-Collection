// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findCashBillsDueForLocalPurge,
  findCashBillsHeldBack,
  findOverdueNeverBackedUp,
  findSettledCreditDueForLocalPurge,
  findSettledCreditHeldBack,
  getPurgeLog,
  hasPurgedAnyBill,
  purgeSaleLocally,
  purgeSettledCreditParty,
  recordPurge,
} from './retention.ts'
import { RETENTION_TOTAL_DAYS } from '../lib/retention.ts'
import {
  assertSafeSeedTarget,
  daysAgoUtc,
  seedCreditRetentionFixtures,
  seedRetentionFixtures,
  type CreditFixture,
} from './seedRetention.ts'
import { getPartyLedger } from './parties.ts'

/**
 * The retention job is the only code in this app that destroys data
 * irreversibly, so these tests carry more weight than any others in the phase.
 *
 * They run the **same fixture the manual seed script builds**
 * (`seedRetentionFixtures`), so there is one description of the world rather
 * than two that could quietly disagree — and every case asserts both halves:
 * that the right rows went, *and* that the wrong ones stayed.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db: Database.Database
let ids: Record<string, number>
let credit: Record<string, CreditFixture>

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  const dir = path.join(__dirname, 'migrations')
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(dir, file), 'utf-8'))
  }
  ids = seedRetentionFixtures(db)
  credit = seedCreditRetentionFixtures(db)
})

const saleExists = (id: number): boolean =>
  db.prepare('SELECT 1 FROM sales WHERE id = ?').get(id) != null

const allSaleIds = (): number[] =>
  (db.prepare('SELECT id FROM sales ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)

describe('the safeguard — which cash bills may be purged', () => {
  /** Criterion 6: old enough, and a successful backup ran after it. */
  it('offers up cash bills past 30 days that a successful backup captured', () => {
    const due = findCashBillsDueForLocalPurge(db).map((s) => s.id)
    expect(due).toEqual([ids['cash-91d-covered'], ids['cash-40d-covered']])
  })

  /**
   * Criterion 7, the case a careless implementation gets wrong. This bill is
   * 31 days old — comfortably past the window — and two backups have run since
   * it was created. Both **failed**, and the only successful backup predates
   * it, so nothing has ever captured it and it must not be touched.
   */
  it('holds back a bill no successful backup ran after, however old it is', () => {
    const heldBack = findCashBillsHeldBack(db).map((s) => s.id)
    expect(heldBack).toEqual([ids['cash-31d-uncovered']])
    expect(findCashBillsDueForLocalPurge(db).map((s) => s.id)).not.toContain(ids['cash-31d-uncovered'])
  })

  /** The specific mistake: dropping `status = 'success'` would make the recent failures count. */
  it('does not treat failed backup attempts as backups', () => {
    expect(db.prepare("SELECT COUNT(*) c FROM backup_log WHERE status = 'failed'").get()).toEqual({ c: 2 })
    expect(findCashBillsDueForLocalPurge(db).map((s) => s.id)).not.toContain(ids['cash-31d-uncovered'])
  })

  /** The other specific mistake: dropping `b.created_at > s.created_at` would count a backup taken before the sale existed. */
  it('does not treat a backup taken before the sale as covering it', () => {
    const backupAt = (
      db.prepare("SELECT created_at FROM backup_log WHERE status = 'success'").get() as { created_at: string }
    ).created_at
    const saleAt = (
      db.prepare('SELECT created_at FROM sales WHERE id = ?').get(ids['cash-31d-uncovered']) as { created_at: string }
    ).created_at

    expect(backupAt < saleAt).toBe(true)
    expect(findCashBillsHeldBack(db).map((s) => s.id)).toContain(ids['cash-31d-uncovered'])
  })

  /** Criterion 8: credit sales are exempt, at any age, backed up or not. */
  it('never offers a credit sale, however old', () => {
    const considered = [...findCashBillsDueForLocalPurge(db), ...findCashBillsHeldBack(db)].map((s) => s.id)
    expect(considered).not.toContain(ids['credit-91d'])
    expect(considered).not.toContain(ids['credit-40d'])
  })

  it('never offers a bill inside the 30-day window', () => {
    const considered = [...findCashBillsDueForLocalPurge(db), ...findCashBillsHeldBack(db)].map((s) => s.id)
    expect(considered).not.toContain(ids['cash-5d'])
  })

  it('reads nothing as due when there has never been a successful backup at all', () => {
    db.prepare("DELETE FROM backup_log WHERE status = 'success'").run()
    expect(findCashBillsDueForLocalPurge(db)).toEqual([])
    expect(findCashBillsHeldBack(db).map((s) => s.id)).toEqual([
      ids['cash-91d-covered'],
      ids['cash-40d-covered'],
      ids['cash-31d-uncovered'],
    ])
  })
})

describe('findOverdueNeverBackedUp', () => {
  it('is empty while held-back bills are still inside their 60 days', () => {
    expect(findOverdueNeverBackedUp(db)).toEqual([])
  })

  /**
   * A bill past day 90 that was never backed up is **still not deleted**. The
   * rule says day 90 is the end; the safeguard says never destroy the only
   * copy. When they disagree the safeguard wins, and this list is how the Owner
   * finds out that Drive has been broken for months.
   */
  it('reports a bill past its purge_at that was never captured, without making it purgeable', () => {
    db.prepare("DELETE FROM backup_log WHERE status = 'success'").run()

    const overdue = findOverdueNeverBackedUp(db).map((s) => s.id)
    expect(overdue).toEqual([ids['cash-91d-covered']])
    // Reported, but emphatically not offered up for deletion.
    expect(findCashBillsDueForLocalPurge(db)).toEqual([])
  })
})

describe('purgeSaleLocally', () => {
  it('removes the sale, its items and its whatsapp_log rows together', () => {
    const target = findCashBillsDueForLocalPurge(db)[0]

    purgeSaleLocally(db, target)

    expect(saleExists(target.id)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM sale_items WHERE sale_id = ?').get(target.id)).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) c FROM whatsapp_log WHERE sale_id = ?').get(target.id)).toEqual({ c: 0 })
  })

  /**
   * `whatsapp_log.sale_id` references `sales(id)` with no ON DELETE CASCADE and
   * `foreign_keys = ON`, so deleting the sale first fails outright. Every sale
   * in the fixture has a log row precisely so this cannot pass by accident.
   */
  it('does not trip the whatsapp_log foreign key', () => {
    const target = findCashBillsDueForLocalPurge(db)[0]
    expect(db.prepare('SELECT COUNT(*) c FROM whatsapp_log WHERE sale_id = ?').get(target.id)).toEqual({ c: 1 })

    expect(() => purgeSaleLocally(db, target)).not.toThrow()
  })

  it('leaves every other sale exactly where it was', () => {
    const before = allSaleIds()
    const target = findCashBillsDueForLocalPurge(db)[0]

    purgeSaleLocally(db, target)

    expect(allSaleIds()).toEqual(before.filter((id) => id !== target.id))
  })

  /**
   * The property that makes this whole job safe: a cash bill has
   * `credit_amount = 0`, and `getPartyLedger` derives a sale's ledger delta
   * from `credit_amount` — so removing cash bills cannot move what a customer
   * owes, however many are purged.
   */
  it('does not move the party balance or the running ledger', () => {
    const partyId = (db.prepare('SELECT id FROM parties LIMIT 1').get() as { id: number }).id
    const balanceBefore = (db.prepare('SELECT balance FROM parties WHERE id = ?').get(partyId) as { balance: number })
      .balance
    // The entries that actually carry money: a cash bill contributes `amount: 0`
    // and leaves `runningBalance` untouched as it passes, so the credit entries
    // must come back byte-identical — running balances included.
    const creditEntriesBefore = getPartyLedger(db, partyId)!.entries.filter((e) => e.amount !== 0)
    expect(creditEntriesBefore.length).toBeGreaterThan(0)

    for (const sale of findCashBillsDueForLocalPurge(db)) purgeSaleLocally(db, sale)

    const balanceAfter = (db.prepare('SELECT balance FROM parties WHERE id = ?').get(partyId) as { balance: number })
      .balance
    expect(balanceAfter).toBe(balanceBefore)

    const creditEntriesAfter = getPartyLedger(db, partyId)!.entries.filter((e) => e.amount !== 0)
    expect(creditEntriesAfter).toEqual(creditEntriesBefore)
  })

  it('writes an audit line naming the bill and when it was rung up', () => {
    const target = findCashBillsDueForLocalPurge(db)[0]

    purgeSaleLocally(db, target)

    const [entry] = getPurgeLog(db)
    expect(entry.action).toBe('local_purge')
    expect(entry.sale_id).toBe(target.id)
    expect(entry.sale_created_at).toBe(target.created_at)
  })

  /**
   * The audit trail must not become a partial copy of the bill — that would
   * contradict "permanently deleted ... no snapshot retained anywhere".
   */
  it('keeps no money and no customer in the audit line', () => {
    const target = findCashBillsDueForLocalPurge(db)[0]
    purgeSaleLocally(db, target)

    const columns = (db.pragma('table_info(purge_log)') as Array<{ name: string }>).map((c) => c.name)
    for (const forbidden of ['grand_total', 'cash_amount', 'party_id', 'amount', 'customer']) {
      expect(columns).not.toContain(forbidden)
    }
  })

  it('purging everything due leaves exactly the exempt and in-window sales', () => {
    for (const sale of findCashBillsDueForLocalPurge(db)) purgeSaleLocally(db, sale)

    const creditSaleIds = Object.values(credit).flatMap((fixture) => fixture.saleIds)
    expect(allSaleIds()).toEqual(
      [ids['cash-31d-uncovered'], ids['credit-91d'], ids['credit-40d'], ids['cash-5d'], ...creditSaleIds].sort(
        (a, b) => a - b,
      ),
    )
  })
})

describe('hasPurgedAnyBill', () => {
  it('is false until a bill has actually been removed, so Reports stays quiet on a shop that never enabled this', () => {
    expect(hasPurgedAnyBill(db)).toBe(false)

    recordPurge(db, { action: 'drive_snapshot_delete', driveFileId: 'x', fileName: 'y.db' })
    expect(hasPurgedAnyBill(db)).toBe(false)

    purgeSaleLocally(db, findCashBillsDueForLocalPurge(db)[0])
    expect(hasPurgedAnyBill(db)).toBe(true)
  })
})

describe('the seed script safety guard', () => {
  /**
   * Not a nicety. The seed script exists so an irreversible job can be
   * developed without touching real data, and a guard that could be bypassed by
   * a mistyped path would defeat its entire purpose.
   */
  it('refuses the real database path, case-insensitively', () => {
    const real = path.join(process.env.APPDATA ?? 'C:/Users/x/AppData/Roaming', 'Swastik Collection Billing', 'app.db')
    expect(() => assertSafeSeedTarget(real)).toThrow(/real database/)
    expect(() => assertSafeSeedTarget(real.toUpperCase())).toThrow(/real database/)
  })

  it('refuses anything named app.db, wherever it is', () => {
    expect(() => assertSafeSeedTarget('C:/somewhere/else/app.db')).toThrow(/named app\.db/)
    expect(() => assertSafeSeedTarget('./app.db')).toThrow(/named app\.db/)
  })

  it('allows a distinctly-named test database', () => {
    expect(() => assertSafeSeedTarget('C:/tmp/retention-fixture.db')).not.toThrow()
  })
})

describe('the fixture itself', () => {
  /** If the timeline stops being what the tests above assume, they stop meaning what they say. */
  it('places exactly one successful backup, between the covered and uncovered sales', () => {
    const successes = db
      .prepare("SELECT created_at FROM backup_log WHERE status = 'success'")
      .all() as Array<{ created_at: string }>
    expect(successes).toHaveLength(1)

    const backupAt = successes[0].created_at
    const covered = db.prepare('SELECT created_at FROM sales WHERE id = ?').get(ids['cash-40d-covered']) as {
      created_at: string
    }
    const uncovered = db.prepare('SELECT created_at FROM sales WHERE id = ?').get(ids['cash-31d-uncovered']) as {
      created_at: string
    }

    expect(covered.created_at < backupAt).toBe(true)
    expect(uncovered.created_at > backupAt).toBe(true)
  })

  it('dates purge_at RETENTION_TOTAL_DAYS after created_at, exactly as createSale does', () => {
    const row = db.prepare('SELECT created_at, purge_at FROM sales WHERE id = ?').get(ids['cash-5d']) as {
      created_at: string
      purge_at: string
    }
    expect(row.purge_at.slice(0, 10)).toBe(daysAgoUtc(5 - RETENTION_TOTAL_DAYS).slice(0, 10))
    expect(row.purge_at > row.created_at).toBe(true)
  })
})

/**
 * Credit bills (client decision, 2026-09-19): kept while owed, removed 60 days
 * after the party clears them — 30 days here, then Drive only. Runs on the same
 * fixture timeline: one successful backup 35 days ago.
 */
describe('credit bills — settled parties only', () => {
  const dueIds = (): number[] => findSettledCreditDueForLocalPurge(db).map((s) => s.id)
  const heldIds = (): number[] => findSettledCreditHeldBack(db).map((s) => s.id)

  it('offers a party that paid everything off 30+ days ago and was backed up afterwards', () => {
    expect(dueIds()).toEqual(credit['settled-covered'].saleIds)
  })

  it('holds back a settled party whose last activity no successful backup has captured', () => {
    expect(heldIds()).toEqual(credit['settled-uncovered'].saleIds)
    expect(dueIds()).not.toContain(credit['settled-uncovered'].saleIds[0])
  })

  it('never touches a party that still owes anything, however old the bill', () => {
    // credit-91d and credit-40d sit on a party with a 1,650 balance.
    const considered = [...dueIds(), ...heldIds()]
    expect(considered).not.toContain(ids['credit-91d'])
    expect(considered).not.toContain(ids['credit-40d'])
  })

  it('starts the clock over when a customer borrows again', () => {
    const considered = [...dueIds(), ...heldIds()]
    for (const saleId of credit['reborrowed'].saleIds) expect(considered).not.toContain(saleId)
  })

  it('leaves a settled party alone until 30 days after they cleared it', () => {
    const considered = [...dueIds(), ...heldIds()]
    expect(considered).not.toContain(credit['settled-recent'].saleIds[0])
  })

  it('never touches a party holding an advance — its payments are the only record of it', () => {
    const considered = [...dueIds(), ...heldIds()]
    expect(considered).not.toContain(credit['advance'].saleIds[0])
  })

  it('does not count a failed backup, or one taken before the last payment, as covering it', () => {
    db.prepare("DELETE FROM backup_log WHERE status = 'success'").run()
    expect(dueIds()).toEqual([])
    expect(heldIds()).toEqual(
      [...credit['settled-covered'].saleIds, ...credit['settled-uncovered'].saleIds].sort((a, b) => a - b),
    )
  })

  it('removes the party credit bills, items, whatsapp_log rows and payments together, and logs each bill', () => {
    const { partyId, saleIds } = credit['settled-covered']
    const removed = purgeSettledCreditParty(db, partyId, findSettledCreditDueForLocalPurge(db))

    expect(removed).toBe(saleIds.length)
    for (const id of saleIds) {
      expect(saleExists(id)).toBe(false)
      expect(db.prepare('SELECT 1 FROM sale_items WHERE sale_id = ?').get(id)).toBeUndefined()
      expect(db.prepare('SELECT 1 FROM whatsapp_log WHERE sale_id = ?').get(id)).toBeUndefined()
    }
    expect(db.prepare('SELECT COUNT(*) c FROM payments WHERE party_id = ?').get(partyId)).toEqual({ c: 0 })
    expect(getPurgeLog(db).filter((row) => row.action === 'local_purge').map((row) => row.sale_id)).toEqual(
      [...saleIds].reverse(),
    )
  })

  it('keeps the party, their balance and a consistent, empty ledger', () => {
    const { partyId } = credit['settled-covered']
    purgeSettledCreditParty(db, partyId, findSettledCreditDueForLocalPurge(db))

    const ledger = getPartyLedger(db, partyId)!
    expect(ledger.party.balance).toBe(0)
    expect(ledger.entries).toEqual([])
  })

  it('leaves every other party, and every cash bill, exactly where it was', () => {
    const { partyId } = credit['settled-covered']
    const before = allSaleIds().filter((id) => !credit['settled-covered'].saleIds.includes(id))

    purgeSettledCreditParty(db, partyId, findSettledCreditDueForLocalPurge(db))

    expect(allSaleIds()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) c FROM payments WHERE party_id = ?').get(credit['advance'].partyId)).toEqual({
      c: 1,
    })
  })

  it('refuses to remove anything if the party stopped being settled since the list was made', () => {
    const { partyId } = credit['settled-covered']
    const candidates = findSettledCreditDueForLocalPurge(db)
    db.prepare('UPDATE parties SET balance = 40 WHERE id = ?').run(partyId)

    expect(purgeSettledCreditParty(db, partyId, candidates)).toBe(0)
    for (const id of credit['settled-covered'].saleIds) expect(saleExists(id)).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM payments WHERE party_id = ?').get(partyId)).toEqual({ c: 1 })
  })

  it('reads a float-residue balance as settled, not as owing', () => {
    const { partyId } = credit['settled-covered']
    db.prepare('UPDATE parties SET balance = ? WHERE id = ?').run(5.7e-14, partyId)
    expect(dueIds()).toEqual(credit['settled-covered'].saleIds)
  })
})
