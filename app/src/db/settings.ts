import type Database from 'better-sqlite3'
import type { SafeUser } from '../types/user.js'
import type { LabelSize, ShopSettings, ShopSettingsInput } from '../types/settings.js'
import { assertPermission } from './permissions.js'
import {
  DEFAULT_LABEL_HEIGHT_MM,
  DEFAULT_LABEL_WIDTH_MM,
  MAX_LABEL_DIMENSION_MM,
  MIN_LABEL_DIMENSION_MM,
} from '../lib/labelLayout.js'
import {
  validateOwnerWhatsAppNumber,
  validateShopAddress,
  validateShopName,
  validateShopPhone,
} from '../lib/settingsValidation.js'
import { DEFAULT_BACKUP_TIME, validateScheduleTime } from '../lib/backupSchedule.js'
import type { BackupSchedule } from '../types/backup.js'

const LABEL_WIDTH_KEY = 'label_width_mm'
const LABEL_HEIGHT_KEY = 'label_height_mm'

const SHOP_NAME_KEY = 'shop_name'
const SHOP_ADDRESS_KEY = 'shop_address'
const SHOP_PHONE_KEY = 'shop_phone'
const OWNER_WHATSAPP_NUMBER_KEY = 'owner_whatsapp_number'

const BACKUP_TIME_KEY = 'backup_time_of_day'
const BACKUP_ON_CLOSE_KEY = 'backup_on_app_close'
const DRIVE_CLIENT_ID_KEY = 'drive_client_id'
const DRIVE_CLIENT_SECRET_KEY = 'drive_client_secret'

const RETENTION_ENABLED_KEY = 'retention_enabled'
const RETENTION_LAST_RUN_KEY = 'retention_last_run_at'

function readSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

/**
 * Both roles read this (both roles print labels — PHASE4.md section 6), so
 * this has no permission gate, matching the read side of every other
 * both-roles feature in this codebase. Falls back to the original
 * client-confirmed 50mm x 25mm size until the Owner saves a setting.
 */
export function getLabelSize(db: Database.Database): LabelSize {
  const width = readSetting(db, LABEL_WIDTH_KEY)
  const height = readSetting(db, LABEL_HEIGHT_KEY)
  return {
    widthMm: width != null ? Number(width) : DEFAULT_LABEL_WIDTH_MM,
    heightMm: height != null ? Number(height) : DEFAULT_LABEL_HEIGHT_MM,
  }
}

/** Owner-only per the central `PERMISSIONS` table's `settings:edit` entry. */
export function setLabelSize(db: Database.Database, user: SafeUser, size: LabelSize): LabelSize {
  assertPermission(user.role, 'settings:edit')

  if (!Number.isFinite(size.widthMm) || size.widthMm < MIN_LABEL_DIMENSION_MM || size.widthMm > MAX_LABEL_DIMENSION_MM) {
    throw new Error(`Label width must be between ${MIN_LABEL_DIMENSION_MM}mm and ${MAX_LABEL_DIMENSION_MM}mm.`)
  }
  if (
    !Number.isFinite(size.heightMm) ||
    size.heightMm < MIN_LABEL_DIMENSION_MM ||
    size.heightMm > MAX_LABEL_DIMENSION_MM
  ) {
    throw new Error(`Label height must be between ${MIN_LABEL_DIMENSION_MM}mm and ${MAX_LABEL_DIMENSION_MM}mm.`)
  }

  writeSetting(db, LABEL_WIDTH_KEY, String(size.widthMm))
  writeSetting(db, LABEL_HEIGHT_KEY, String(size.heightMm))
  return size
}

/**
 * The shop's own details (PHASE12.md section 1) — the single source for the
 * printed bill header (src/components/Bill.tsx) *and* the WhatsApp bill image
 * and Owner send (electron/whatsapp/send.ts). Replaces the two separate sets
 * of hardcoded constants Phases 6 and 7 shipped with.
 *
 * **No permission gate**, matching `getLabelSize` above for the same reason:
 * a Salesman prints bills too, so the renderer needs the header regardless of
 * role. `settings:edit` gates the *write* below, which is where the Owner-only
 * rule actually lives.
 *
 * Falls back to empty strings rather than to any hardcoded shop identity — the
 * real values are seeded once by migration `009_shop_settings.sql` and are
 * ordinary editable rows after that. An empty string here means "nobody has
 * filled this in", which the bill header and the Settings screen both render
 * honestly, instead of a stand-in quietly reappearing in the code.
 */
export function getShopSettings(db: Database.Database): ShopSettings {
  return {
    shopName: readSetting(db, SHOP_NAME_KEY) ?? '',
    shopAddress: readSetting(db, SHOP_ADDRESS_KEY) ?? '',
    shopPhone: readSetting(db, SHOP_PHONE_KEY) ?? '',
    ownerWhatsappNumber: readSetting(db, OWNER_WHATSAPP_NUMBER_KEY) ?? '',
  }
}

/**
 * Owner-only per the central `PERMISSIONS` table's `settings:edit` entry.
 *
 * Validates every field through the same pure functions the Settings screen
 * uses for its inline errors (src/lib/settingsValidation.ts), and validates
 * **all** of them before writing **any** of them: a save that rejected the
 * WhatsApp number after already committing a new shop name would leave the two
 * halves of one form in different states, and the operator would have no way
 * to tell which half landed. The four writes then go in one transaction for
 * the same reason.
 */
export function setShopSettings(db: Database.Database, user: SafeUser, input: ShopSettingsInput): ShopSettings {
  assertPermission(user.role, 'settings:edit')

  const shopName = input.shopName.trim()
  const shopAddress = input.shopAddress.trim()
  const shopPhone = input.shopPhone.trim()
  const ownerWhatsappNumber = input.ownerWhatsappNumber.trim()

  const error =
    validateShopName(shopName) ??
    validateShopAddress(shopAddress) ??
    validateShopPhone(shopPhone) ??
    validateOwnerWhatsAppNumber(ownerWhatsappNumber)
  if (error) throw new Error(error)

  const saved: ShopSettings = { shopName, shopAddress, shopPhone, ownerWhatsappNumber }

  db.transaction(() => {
    writeSetting(db, SHOP_NAME_KEY, saved.shopName)
    writeSetting(db, SHOP_ADDRESS_KEY, saved.shopAddress)
    writeSetting(db, SHOP_PHONE_KEY, saved.shopPhone)
    writeSetting(db, OWNER_WHATSAPP_NUMBER_KEY, saved.ownerWhatsappNumber)
  })()

  return saved
}

/**
 * When automatic backups run (PHASE12.md sections 1-2). Deferred out of Prompt
 * 1 deliberately — a schedule setting with no backup engine behind it would
 * have been a control that does nothing, which this codebase does not ship.
 *
 * Ungated like `getLabelSize`/`getShopSettings`: the *scheduler* reads this
 * main-side on a timer with no user in hand at all, so a permission gate here
 * would have nothing to check against. `setBackupSchedule` is where the
 * Owner-only rule lives.
 *
 * Both defaults are on. A backup feature that ships switched off is a backup
 * feature the shop discovers it never had.
 */
export function getBackupSchedule(db: Database.Database): BackupSchedule {
  const time = readSetting(db, BACKUP_TIME_KEY)
  const onClose = readSetting(db, BACKUP_ON_CLOSE_KEY)
  return {
    // A stored value that somehow isn't a valid time falls back rather than
    // propagating: `isScheduledBackupDue` refuses to fire on a malformed
    // schedule, so honouring garbage here would silently disable backups.
    timeOfDay: time && !validateScheduleTime(time) ? time : DEFAULT_BACKUP_TIME,
    onAppClose: onClose == null ? true : onClose === '1',
  }
}

/** Owner-only per the central `PERMISSIONS` table's `settings:edit` entry. */
export function setBackupSchedule(
  db: Database.Database,
  user: SafeUser,
  schedule: BackupSchedule,
): BackupSchedule {
  assertPermission(user.role, 'settings:edit')

  const timeOfDay = schedule.timeOfDay.trim()
  const error = validateScheduleTime(timeOfDay)
  if (error) throw new Error(error)

  const saved: BackupSchedule = { timeOfDay, onAppClose: schedule.onAppClose }
  db.transaction(() => {
    writeSetting(db, BACKUP_TIME_KEY, saved.timeOfDay)
    writeSetting(db, BACKUP_ON_CLOSE_KEY, saved.onAppClose ? '1' : '0')
  })()
  return saved
}

/**
 * The Google OAuth client the Owner registered for this shop (PHASE12.md
 * section 2's "the app's Google Drive access").
 *
 * These live in `settings` rather than in the source because there is no
 * shared, pre-registered client to bake in: whoever sets the shop up creates a
 * Google Cloud project and pastes its Desktop-app client here. That also keeps
 * a credential out of the repository permanently.
 *
 * **Main-process reads only.** `getBackupStatus` sends the renderer the client
 * id (which is not a secret — Google puts it in the consent URL) and only a
 * boolean for the secret, the same discipline that keeps `password_hash` out of
 * `UserListRow`.
 */
export function getDriveCredentials(db: Database.Database): { clientId: string; clientSecret: string } {
  return {
    clientId: readSetting(db, DRIVE_CLIENT_ID_KEY) ?? '',
    clientSecret: readSetting(db, DRIVE_CLIENT_SECRET_KEY) ?? '',
  }
}

/**
 * Owner-only. A blank `clientSecret` **leaves the stored one alone** rather
 * than clearing it: the Settings screen never receives the current secret to
 * render, so an Owner editing the client id and saving would otherwise wipe the
 * secret they couldn't see. Clearing both is what Disconnect is for.
 */
export function setDriveCredentials(
  db: Database.Database,
  user: SafeUser,
  input: { clientId: string; clientSecret: string },
): void {
  assertPermission(user.role, 'settings:edit')

  const clientId = input.clientId.trim()
  const clientSecret = input.clientSecret.trim()
  if (!clientId) throw new Error('A Google OAuth Client ID is required.')
  if (!clientSecret && !readSetting(db, DRIVE_CLIENT_SECRET_KEY)) {
    throw new Error('A Google OAuth Client Secret is required the first time.')
  }

  db.transaction(() => {
    writeSetting(db, DRIVE_CLIENT_ID_KEY, clientId)
    if (clientSecret) writeSetting(db, DRIVE_CLIENT_SECRET_KEY, clientSecret)
  })()
}

/**
 * Whether the retention/purge job is allowed to run at all (PHASE12.md
 * section 3).
 *
 * **Defaults to off, and that is a safety requirement rather than a
 * preference.** This is the only code in the app that destroys data
 * irreversibly, and Prompt 3's own instruction is that it must not be pointed
 * at anything real without an explicit decision. Shipping it switched on would
 * make that decision for the shop on first launch.
 *
 * Ungated on read, like `getBackupSchedule`: the scheduler consults it on a
 * timer with no user in hand to check a permission against.
 */
export function getRetentionEnabled(db: Database.Database): boolean {
  return readSetting(db, RETENTION_ENABLED_KEY) === '1'
}

/** Owner-only, and gated by `retention:run` rather than `settings:edit` — turning the purge job on is the same decision as running it. */
export function setRetentionEnabled(db: Database.Database, user: SafeUser, enabled: boolean): boolean {
  assertPermission(user.role, 'retention:run')
  writeSetting(db, RETENTION_ENABLED_KEY, enabled ? '1' : '0')
  return enabled
}

/** When the job last *checked*, which is not the same as when it last deleted something — a run that found nothing to do still counts as the job working. */
export function getRetentionLastRunAt(db: Database.Database): string | null {
  return readSetting(db, RETENTION_LAST_RUN_KEY)
}

/** Stamped from SQLite's own clock, so it reads on the same scale as every `created_at` beside it. */
export function markRetentionRun(db: Database.Database): void {
  const now = db.prepare("SELECT datetime('now') AS now").get() as { now: string }
  writeSetting(db, RETENTION_LAST_RUN_KEY, now.now)
}

/** Owner-only — wipes the stored client so a re-setup starts clean. Called by Disconnect alongside dropping the token file. */
export function clearDriveCredentials(db: Database.Database, user: SafeUser): void {
  assertPermission(user.role, 'settings:edit')
  db.transaction(() => {
    writeSetting(db, DRIVE_CLIENT_ID_KEY, '')
    writeSetting(db, DRIVE_CLIENT_SECRET_KEY, '')
  })()
}
