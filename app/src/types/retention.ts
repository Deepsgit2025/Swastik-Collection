/** What a `purge_log` row records. `local_purge` removed a bill from SQLite; `drive_snapshot_delete` removed a whole snapshot file from Drive. */
export type PurgeAction = 'local_purge' | 'drive_snapshot_delete'

/**
 * One line of the retention audit trail.
 *
 * Deliberately carries **no money and no customer** — see migration
 * `011_purge_log.sql`. It answers "where did bill #123 from May go?" without
 * being a partial copy of the bill, which would contradict the rule it exists
 * to record the enforcement of.
 */
export interface PurgeLogRow {
  id: number
  action: PurgeAction
  sale_id: number | null
  sale_created_at: string | null
  drive_file_id: string | null
  file_name: string | null
  created_at: string
}

/** A cash bill the job has an opinion about — identity and dates only, for the same reason `purge_log` holds no figures. */
export interface RetentionCandidate {
  id: number
  created_at: string
  purge_at: string | null
}

/** A credit bill of a fully settled party. `party_id` is there because credit bills are removed party by party, together with that party's payments. */
export interface CreditRetentionCandidate extends RetentionCandidate {
  party_id: number
}

/**
 * What the dry run reports, and what the Owner's status panel renders.
 *
 * `heldBack` is the safeguard doing its job: bills old enough to purge that no
 * successful backup has ever captured. A number here that keeps growing means
 * Drive backups are failing and the shop is one disk failure from losing them —
 * which is exactly why it is shown rather than only counted.
 */
export interface RetentionPreview {
  enabled: boolean
  lastRunAt: string | null
  /** Cash bills 30+ days old that a successful backup has captured — these would be removed locally. */
  dueForLocalPurge: RetentionCandidate[]
  /** Cash bills 30+ days old with no successful backup covering them — these are deliberately left alone. */
  heldBack: RetentionCandidate[]
  /** Credit bills of parties who cleared everything 30+ days ago, backed up — these (and those parties' payments) would be removed locally. */
  creditDueForLocalPurge: CreditRetentionCandidate[]
  /** The same credit bills with no backup after the party's last activity — left alone. */
  creditHeldBack: CreditRetentionCandidate[]
  /**
   * Held-back cash bills that are also past their final day (60). The safeguard
   * still wins — they are not deleted — but they are the loudest possible sign
   * that backups have been broken for months.
   */
  overdueNeverBackedUp: RetentionCandidate[]
  /** Snapshot files old enough to sweep from Drive. Null when Drive is not connected, which is different from "none". */
  snapshotsToDelete: Array<{ driveFileId: string; fileName: string; takenAt: string | null }> | null
}

/** What a real run actually did. */
export interface RetentionRunResult {
  /** Bills removed locally this run — cash and settled-credit together. */
  purgedLocally: number
  /** Bills the safeguard held back — cash and credit together. */
  heldBack: number
  snapshotsDeleted: number
  error: string | null
}
