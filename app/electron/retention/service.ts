import type Database from 'better-sqlite3'
import { assertPermission } from '../../src/db/permissions.js'
import {
  findCashBillsDueForLocalPurge,
  findCashBillsHeldBack,
  findOverdueNeverBackedUp,
  findSettledCreditDueForLocalPurge,
  findSettledCreditHeldBack,
  getPurgeLog,
  purgeSaleLocally,
  purgeSettledCreditParty,
  recordPurge,
} from '../../src/db/retention.js'
import { getRetentionEnabled, getRetentionLastRunAt, markRetentionRun, setRetentionEnabled } from '../../src/db/settings.js'
import { snapshotsToDelete } from '../../src/lib/retention.js'
import type { PurgeLogRow, RetentionPreview, RetentionRunResult } from '../../src/types/retention.js'
import type { RestorePoint } from '../../src/types/backup.js'
import type { SafeUser } from '../../src/types/user.js'
import { deleteSnapshot, listSnapshots } from '../backup/googleDrive.js'
import { driveAccessToken, driveFolderId, isDriveConnected } from '../backup/service.js'

/**
 * The retention/purge job (PHASE12.md section 3) — the only code in this app
 * that deliberately and irreversibly destroys data.
 *
 * Everything it *decides* lives elsewhere and is tested there: which bills are
 * eligible in `src/db/retention.ts` (the safeguard), which snapshots have
 * expired in `src/lib/retention.ts` (the 60-day derivation). This file only
 * carries those decisions out, which is what keeps the destructive path itself
 * thin enough to read in one sitting.
 *
 * **It does nothing at all until an Owner turns it on.** `retention_enabled`
 * defaults to off (`src/db/settings.ts`), and the scheduler checks it on every
 * pass. That is the standing instruction from Prompt 3 — this must not be
 * pointed at real data without a deliberate decision — expressed as a switch
 * rather than as a note in a document.
 */

/** Checked at launch and hourly. A shop that leaves the app open for days would never fire a launch-only check — the same reasoning the backup scheduler uses. */
const RETENTION_POLL_MS = 60 * 60 * 1000

let retentionTimer: NodeJS.Timeout | null = null
/** Guards a scheduled pass and a manual click from running the destructive half twice over the same rows. */
let runInFlight = false

/**
 * What the job *would* do, touching nothing.
 *
 * The dry run exists because an irreversible delete should be inspectable
 * before it happens, and because it is the only honest way to answer "what will
 * this do to my data?" for a shop deciding whether to switch it on. It is also
 * what the status panel renders continuously, so the held-back count is visible
 * whether or not the job is enabled.
 */
export async function previewRetention(db: Database.Database, user: SafeUser): Promise<RetentionPreview> {
  assertPermission(user.role, 'retention:view')

  let expiredSnapshots: RetentionPreview['snapshotsToDelete'] = null
  if (isDriveConnected()) {
    try {
      const points = await listSnapshotsForSweep(db)
      expiredSnapshots = snapshotsToDelete(points).map((point) => ({
        driveFileId: point.driveFileId,
        fileName: point.fileName,
        takenAt: point.takenAt,
      }))
    } catch (err) {
      // A Drive that cannot be reached is reported as "unknown" (null) rather
      // than as "nothing to delete" — those are very different statements to
      // make to someone deciding whether this job is working.
      console.error('[retention] could not list snapshots for the preview:', err)
      expiredSnapshots = null
    }
  }

  return {
    enabled: getRetentionEnabled(db),
    lastRunAt: getRetentionLastRunAt(db),
    dueForLocalPurge: findCashBillsDueForLocalPurge(db),
    heldBack: findCashBillsHeldBack(db),
    creditDueForLocalPurge: findSettledCreditDueForLocalPurge(db),
    creditHeldBack: findSettledCreditHeldBack(db),
    overdueNeverBackedUp: findOverdueNeverBackedUp(db),
    snapshotsToDelete: expiredSnapshots,
  }
}

function heldBackCount(db: Database.Database): number {
  return findCashBillsHeldBack(db).length + findSettledCreditHeldBack(db).length
}

async function listSnapshotsForSweep(db: Database.Database): Promise<RestorePoint[]> {
  const accessToken = await driveAccessToken(db)
  return listSnapshots(accessToken, await driveFolderId(accessToken))
}

/**
 * Runs the job for real.
 *
 * Order matters. The **local purge runs first**, and only over bills the
 * safeguard has cleared; the Drive sweep runs second and independently. If the
 * sweep fails, the local half has still happened correctly — and crucially, a
 * failure in either half can never make the other one *more* destructive, since
 * neither consults the other's outcome.
 *
 * Held-back bills are counted and returned but never touched. A bill past day
 * 90 that was never backed up stays put too: the rule says day 90 is the end,
 * the safeguard says never destroy the only copy, and where those disagree the
 * safeguard wins (see `findOverdueNeverBackedUp`).
 */
export async function runRetention(db: Database.Database, user: SafeUser): Promise<RetentionRunResult> {
  assertPermission(user.role, 'retention:run')

  if (!getRetentionEnabled(db)) {
    return {
      purgedLocally: 0,
      heldBack: 0,
      snapshotsDeleted: 0,
      error: 'Retention is switched off. Turn it on in Settings first.',
    }
  }
  if (runInFlight) {
    return { purgedLocally: 0, heldBack: 0, snapshotsDeleted: 0, error: 'A retention run is already in progress.' }
  }
  runInFlight = true

  let purgedLocally = 0
  let snapshotsDeleted = 0
  let error: string | null = null

  try {
    const due = findCashBillsDueForLocalPurge(db)
    for (const sale of due) {
      purgeSaleLocally(db, sale)
      purgedLocally += 1
      console.log(`[retention] purged sale ${sale.id} (created ${sale.created_at}) from local storage`)
    }

    // Credit bills go party by party (with that party's payments), and only for
    // parties whose balance is exactly zero and whose last activity is 30+ days
    // old and covered by a backup — see `findSettledCreditDueForLocalPurge`.
    const creditDue = findSettledCreditDueForLocalPurge(db)
    const creditByParty = new Map<number, typeof creditDue>()
    for (const sale of creditDue) {
      const group = creditByParty.get(sale.party_id) ?? []
      group.push(sale)
      creditByParty.set(sale.party_id, group)
    }
    for (const [partyId, sales] of creditByParty) {
      const removed = purgeSettledCreditParty(db, partyId, sales)
      purgedLocally += removed
      if (removed > 0) console.log(`[retention] purged ${removed} credit bill(s) of settled party ${partyId} from local storage`)
    }

    if (isDriveConnected()) {
      try {
        const points = await listSnapshotsForSweep(db)
        const expired = snapshotsToDelete(points)
        const accessToken = await driveAccessToken(db)
        for (const point of expired) {
          await deleteSnapshot(accessToken, point.driveFileId)
          recordPurge(db, {
            action: 'drive_snapshot_delete',
            driveFileId: point.driveFileId,
            fileName: point.fileName,
          })
          snapshotsDeleted += 1
          console.log(`[retention] deleted expired Drive snapshot ${point.fileName}`)
        }
      } catch (err) {
        // The local half has already succeeded and is recorded; a Drive problem
        // must not be reported as though the whole run failed.
        error = `The local purge succeeded, but the Drive sweep did not: ${err instanceof Error ? err.message : String(err)}`
        console.error('[retention] the Drive sweep failed:', err)
      }
    }

    markRetentionRun(db)
    return { purgedLocally, heldBack: heldBackCount(db), snapshotsDeleted, error }
  } catch (err) {
    console.error('[retention] run failed:', err)
    return {
      purgedLocally,
      heldBack: heldBackCount(db),
      snapshotsDeleted,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    runInFlight = false
  }
}

/**
 * The Owner turning the job on or off.
 *
 * Gated by `retention:run` rather than `settings:edit`: enabling this *is* the
 * decision to delete data, and it should carry the same permission as pressing
 * the button.
 */
export function setRetention(db: Database.Database, user: SafeUser, enabled: boolean): boolean {
  assertPermission(user.role, 'retention:run')
  const result = setRetentionEnabled(db, user, enabled)
  console.log(`[retention] ${result ? 'enabled' : 'disabled'} by ${user.username}`)
  return result
}

export function getPurgeHistory(db: Database.Database, user: SafeUser): PurgeLogRow[] {
  assertPermission(user.role, 'retention:view')
  return getPurgeLog(db)
}

/**
 * The scheduler's own caller — there is no logged-in user on a timer.
 *
 * Not a hole in the IPC identity rule (CLAUDE.md Tech conventions): that rule
 * forbids trusting a *renderer-supplied* role, and nothing outside this process
 * can reach this path. The Owner it acts as comes from `users`, not an argument.
 */
function schedulerUser(db: Database.Database): SafeUser | null {
  const row = db
    .prepare("SELECT id, username, full_name FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY id ASC LIMIT 1")
    .get() as { id: number; username: string; full_name: string } | undefined
  return row ? { ...row, role: 'owner' } : null
}

async function runIfEnabled(db: Database.Database): Promise<void> {
  if (!getRetentionEnabled(db)) return
  const user = schedulerUser(db)
  if (!user) return
  await runRetention(db, user)
}

/**
 * Starts the job: a pass at launch, then hourly.
 *
 * Both are no-ops while `retention_enabled` is off, which is how it ships. The
 * timer exists at all because a shop that leaves the app open for days would
 * otherwise never trigger a launch-only check — PHASE12.md section 3 says so
 * explicitly.
 */
export function startRetentionScheduler(db: Database.Database): void {
  if (retentionTimer) return
  void runIfEnabled(db).catch((err: unknown) => console.error('[retention] launch pass failed:', err))
  retentionTimer = setInterval(() => {
    void runIfEnabled(db).catch((err: unknown) => console.error('[retention] scheduled pass failed:', err))
  }, RETENTION_POLL_MS)
}

export function stopRetentionScheduler(): void {
  if (retentionTimer) clearInterval(retentionTimer)
  retentionTimer = null
}
