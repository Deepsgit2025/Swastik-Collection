# PHASE12.md — Settings, Backup/Sync, and Retention Rules

> Self-contained. Assumes Phases 1–11 complete. Read CLAUDE.md first — this phase implements the final piece of the permanent retention rule: **cash bills live 30 days locally, then 60 more days in Google Drive only, then are permanently deleted with no snapshot kept.** This is a genuine hard delete — treat the purge job with real care and test it thoroughly before it ever runs against real data.

## 0. What This Phase Is For

Three things, all Owner-only:
1. A real Settings screen, replacing the temporary hardcoded values from Phases 6 (Owner's WhatsApp number) and 7 (shop header)
2. Google Drive backup: scheduled + manual, with restore
3. The retention/purge job that implements the 30/60/90-day cash bill lifecycle

This is deliberately the last phase — it touches data created by every other module.

## 1. Settings Screen (`/settings`, Owner-only)

- Shop details: name, address, phone — feeds the Phase 7 bill header (replace the temporary hardcoded values there)
- Owner's WhatsApp number — feeds the Phase 6 send logic (replace the temporary config stand-in there)
- User management: create a new Salesman login, disable/re-enable an existing login (soft-disable via `users.is_active`, not delete — preserves historical `salesman_user_id` references on old sales)
- Backup schedule setting (e.g. daily at a chosen time, or on-app-close — pick one sensible default and make it configurable)
- All settings stored via the `settings` key/value table from the Phase 2 schema

## 2. Google Drive Backup

- OAuth2 connect flow (Owner authorizes the app's Google Drive access once, token persisted)
- **Scheduled backup**: per the Settings schedule, push a snapshot of the local SQLite DB file (plus any generated bill content that needs preserving) to a dedicated app folder in the Owner's Google Drive
- **Manual "Backup Now" button**: triggers the same snapshot push on demand
- Every backup attempt logged in `backup_log` (already in Phase 2 schema): success/failure, Drive file ID, whether it was scheduled or manual
- **Restore flow**: Owner-only, requires an explicit confirmation step (this overwrites local data — make the confirmation unambiguous about what's about to happen), lets the Owner pick a backup point and rebuild the local DB from it

## 3. The Retention / Purge Job — Read Carefully, This Is the Critical Part

Final rule, as confirmed by the client:
- **Day 0–30**: cash bill (`sales.is_cash_bill = true`, computed at creation in Phase 5) lives in local SQLite, fully active and visible everywheverywhere it normally would be.
- **Day 30**: removed from local storage — but it must still exist in whatever Google Drive backup snapshot was most recently taken (so the backup schedule and this purge timing need to be sane relative to each other — don't let something get locally purged before it's ever been backed up even once; see the safeguard below).
- **Day 30–90**: exists **only** in the Google Drive backup, not locally.
- **Day 90**: **permanently deleted from Google Drive as well.** No snapshot retained anywhere. This is irreversible.
- **Credit sales are entirely exempt** — `is_cash_bill = false` sales are never touched by this job, regardless of age, and are retained until their balance is fully cleared (i.e., forever if never cleared).

### Required Safeguard
Before locally purging a cash bill at day 30, the job must confirm that sale's data exists in at least one successful Google Drive backup (check `backup_log` for a successful backup that ran after the sale was created). If no successful backup has ever captured that sale, **do not purge it locally yet** — wait for the next successful backup instead. Never let a day-30 local purge outrun the backup schedule and cause actual data loss earlier than the client intends.

### Implementation
- A scheduled job (run on app launch, and optionally on an interval while the app is open — don't rely solely on app-launch timing since a shop that leaves the app open for days would otherwise never trigger it) that:
  1. Finds cash bills where `created_at` is 30+ days ago and `archived_local = false` and the safeguard above passes → sets `archived_local = true` and removes/excludes them from local active queries (implementation detail: either a real local delete of the row now that it's safely backed up, or an `archived_local` flag that all "active" queries already filter on — pick whichever is simpler given how Phases 5–11 already query `sales`, and make sure every one of those existing queries respects the flag if you go that route)
  2. Finds cash bills where `purge_at` (computed at creation in Phase 5, `created_at + 90 days`) has passed → deletes the corresponding data from the Google Drive backup via the Drive API, and removes any remaining local trace
- Log every purge action somewhere auditable (even just an application log file is fine — this doesn't need its own DB table, but there should be a record of what was purged and when, for the Owner's peace of mind if they ever ask "wait, where did that old bill go")

### Testing Requirement
Given this is an irreversible delete, do not test this against real production data. Build it against a test dataset with artificially backdated `created_at`/`purge_at` values (e.g. a seed script that creates fake sales dated 31 and 91 days in the past) and verify the job behaves correctly before it's ever allowed to run against the real database.

## 4. Data Export (Independent of the Purge Cycle)

- Manual CSV export of full sales history, reachable from Settings, independent of the Phase 11 report exports — this is specifically so the Owner can pull anything they want to keep permanently before the day-90 window closes on it
- Consider a one-time in-app note/reminder near the backup/retention settings, plainly stating that data is permanently deleted at day 90 with nothing kept — this isn't a nag dialog on every launch, just a clear, honest label right next to the setting so it's never a surprise

## 5. Permission Wiring

| Action | Owner | Salesman |
|---|---|---|
| Edit settings | ✅ | ❌ |
| Manage users (create/disable Salesman logins) | ✅ | ❌ |
| Run manual backup | ✅ | ❌ |
| Restore from backup | ✅ | ❌ |
| Trigger/view purge job status | ✅ | ❌ |

Uses `settings:edit`, `user:manage`, `backup:run`, `backup:restore` from Phase 2's table — all Owner-only, all already defined, just wire them to real logic now. Salesman has no route to `/settings` at all.

## 6. Out of Scope This Phase

- Nothing meaningfully deferred further — this is the last phase. If anything here surfaces new scope (e.g. client wants a configurable label template editor after all, mentioned as a maybe in Phase 4), treat it as a new, explicitly scoped follow-up rather than folding it in here.

## 7. Acceptance Criteria

1. Settings screen correctly updates the shop header used by Phase 7's print and the Owner's WhatsApp number used by Phase 6's send — both flow through immediately, no temporary hardcoded values remain anywhere in the codebase
2. Owner can create a new Salesman login from Settings and immediately log in with it; disabling a Salesman login prevents further login but does not break historical sales that reference that user
3. Manual "Backup Now" successfully pushes a snapshot to Google Drive and logs a success row in `backup_log`
4. Scheduled backup runs per the configured schedule without requiring the Owner to manually trigger it
5. Restore correctly rebuilds local data from a chosen backup point, with a clear, unambiguous confirmation step before it overwrites anything
6. Using the seeded test dataset with backdated sales: a cash bill dated 31+ days ago is correctly removed from local active views but still retrievable from the Drive backup; one dated 91+ days ago is confirmed gone from both local and Drive with no trace
7. The safeguard in section 3 is proven: a cash bill that has never been successfully backed up is **not** purged locally even if it's 30+ days old — confirm this with a test case that has a failed/missing backup history
8. A credit sale backdated 91+ days remains fully present, active, and editable-by-Owner — completely unaffected by the purge job
9. CSV export of full sales history works and is reachable from Settings

## 8. Prompts for Claude Code

**Prompt 1 — Settings Screen**
```
Read PHASE12.md fully and CLAUDE.md for permanent rules. Build the Settings screen per section 1, and wire it to replace every temporary hardcoded value from earlier phases: the Phase 6 Owner WhatsApp number and the Phase 7 shop header. Search the codebase for those temporary stand-ins specifically and confirm none remain. Also build user management (create/disable Salesman logins via is_active, never a hard delete of user records).
```

**Prompt 2 — Google Drive Backup**
```
Implement Google Drive OAuth2 connect, scheduled backup per the Settings schedule, manual "Backup Now", and the restore flow per section 2, all Owner-only. Every attempt must log to backup_log. Make the restore confirmation step explicit and unambiguous about what it's about to overwrite.
```

**Prompt 3 — Retention/Purge Job (build against test data only)**
```
This is the most sensitive part of the whole app — read section 3 of PHASE12.md twice before starting. Build a seed script that creates fake cash-bill sales backdated 31 and 91 days, and fake credit sales backdated 91+ days, plus fake backup_log entries to test both the "has been backed up" and "has never been backed up" cases. Only once that test data and the safeguard logic are solid, implement the actual purge job: day-30 local removal (gated by the backup safeguard), day-90 permanent Drive deletion. Do not run this against real data during development — confirm with me explicitly before it's ever pointed at anything real.
```

**Prompt 4 — Data Export + Final Verify**
```
Add the full sales history CSV export per section 4, and the plain-label note about the day-90 permanent deletion near the retention setting. Then go through every item in PHASE12.md section 7 one by one, including the backdated test-data scenarios in criteria 6-8 — walk me through exactly how each was tested before marking this phase, and the whole project, complete.
```
