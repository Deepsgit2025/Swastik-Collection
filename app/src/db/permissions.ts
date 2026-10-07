/**
 * PERMANENT PROJECT RULE (see CLAUDE.md): this file is the single source of
 * truth for role permissions. Every DB write function, in this phase and
 * every phase after it, must call `assertPermission(currentUser.role, action)`
 * as its first line, before touching SQLite. Do not write ad-hoc role
 * if/else checks in screens or write functions, and do not bypass this
 * module with a direct `db.prepare(...)` write call. This is what makes the
 * "Salesman cannot edit/delete anything, even via a modified frontend" rule
 * enforced in the data-access layer instead of just hidden in the UI.
 *
 * New write operation in a later phase? Add its Action here and give it an
 * entry in PERMISSIONS — don't invent a parallel check elsewhere.
 */

import type { Role } from '../types/user.js'

export type Action =
  | 'party:create'
  | 'party:edit'
  | 'party:delete'
  | 'sale:create'
  | 'sale:edit'
  | 'sale:delete'
  | 'sale:reprint'
  | 'sale:print'
  | 'sale:print_override'
  | 'payment:create'
  | 'expense:create'
  | 'expense:edit'
  | 'expense:delete'
  | 'settings:edit'
  | 'user:manage'
  | 'salesman:manage'
  | 'backup:run'
  | 'backup:restore'
  | 'backup:view'
  | 'retention:run'
  | 'retention:view'
  | 'report:view_all'
  | 'barcode:create'
  | 'whatsapp:manage_session'
  | 'whatsapp:view_deliveries'
  | 'whatsapp:resend_bill'

export const PERMISSIONS: Record<Action, Role[]> = {
  'party:create': ['owner', 'salesman'], // salesman quick-add only, enforced further at the field level in Phase 3
  'party:edit': ['owner'],
  'party:delete': ['owner'],
  'sale:create': ['owner', 'salesman'],
  'sale:edit': ['owner'],
  'sale:delete': ['owner'],
  'sale:reprint': ['owner'],
  'sale:print': ['owner', 'salesman'], // PHASE7.md section 4: printing the just-gated sale is allowed for whoever created it — the WhatsApp gate (canPrintSale), not role, is what restricts this
  'sale:print_override': ['owner'], // PHASE6.md section 5 / PHASE7.md section 2: Owner-only "print anyway" override on a WhatsApp send failure
  'payment:create': ['owner', 'salesman'],
  'expense:create': ['owner', 'salesman'], // PHASE9.md section 0/3: confirmed decision, reversing an earlier Owner-only assumption — a Salesman logs expenses too. Add-only; the two below are what keep it add-only.
  'expense:edit': ['owner'], // Owner-only permission with no UI built yet (PHASE9.md section 1) — the rule holds at the backend regardless of what any screen offers
  'expense:delete': ['owner'], // as above
  'settings:edit': ['owner'],
  'user:manage': ['owner'], // now only guards the Owner's own password change — salesman logins no longer exist (2026-08-27)
  // Adding, renaming and retiring the salesman *names* that replaced salesman
  // logins (2026-08-27). Its own Action rather than folded into `user:manage`,
  // per this file's header: a `salesmen` row grants no access to anything, so
  // filing it under the permission that guards login administration would
  // overstate what it does.
  'salesman:manage': ['owner'],
  'backup:run': ['owner'],
  'backup:restore': ['owner'],
  // Read-only twins of the two above (2026-09-19). The Owner-only screens were
  // opened to the counter, so Settings has to be *readable* by it — but every
  // write on that screen still asks for the Owner password. Splitting the read
  // out is what lets `getBackupStatus`/`listRestorePoints` stay safe to call
  // without loosening `backup:run`/`backup:restore` themselves.
  'backup:view': ['owner', 'salesman'],
  // PHASE12.md section 3's retention/purge job — enabling it, previewing it, and
  // running it. Its section 5 table lists "Trigger/view purge job status" as
  // Owner-only but names only the four pre-existing actions, so this is a
  // deliberate addition: the file header above says a new write operation gets
  // its own Action, and this is the most destructive write in the app. Folding
  // it into `backup:run` would make the audit trail read as though a *backup*
  // had deleted the shop's data.
  'retention:run': ['owner'],
  'retention:view': ['owner', 'salesman'], // the preview and the purge log — reading what the job did, never running it
  // Opened to the counter on 2026-09-19 (client decision: "remove the owner
  // lock"). The name is now a slight misnomer — it means "may read the reporting
  // screens" — but it is kept rather than renamed so every reporting function's
  // first-line assert stays exactly as written. Nothing here writes: every edit
  // or delete still needs the Owner password.
  'report:view_all': ['owner', 'salesman'],
  // `report:view_own` was removed on 2026-08-27 along with the Salesman
  // dashboard it existed for. With no salesman login there is no "own" to
  // scope to: every reporting figure in the app is now shop-wide and Owner-only.
  'barcode:create': ['owner', 'salesman'], // PHASE4.md section 6: label generation isn't financial data, both roles get it
  'whatsapp:manage_session': ['owner'], // PHASE6.md section 5: connecting/disconnecting/re-linking the WhatsApp Web session is Owner-only infra setup
  'whatsapp:view_deliveries': ['owner', 'salesman'], // the bill-delivery view on the Connect WhatsApp screen — open since 2026-09-19; connecting/logging out still needs the Owner password
  'whatsapp:resend_bill': ['owner', 'salesman'], // "Send again" on a failed bill send — open since 2026-09-19: it only re-sends recipients still unsent (a no-op on a bill that fully went out), so it is neither an edit nor a delete
}

export class PermissionError extends Error {
  constructor(role: Role, action: Action) {
    super(`Role '${role}' cannot perform '${action}'`)
    this.name = 'PermissionError'
  }
}

/** Throws PermissionError if `role` is not allowed to perform `action`. Call first, before any SQLite write. */
export function assertPermission(role: Role, action: Action): void {
  if (!PERMISSIONS[action].includes(role)) {
    throw new PermissionError(role, action)
  }
}
