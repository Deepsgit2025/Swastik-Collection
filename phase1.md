# PHASE 1.md — Project Scaffolding & Auth

> This file is self-contained. Hand this + CLAUDE.md (below) to Claude Code and it has everything needed to build Phase 1 without referring back to PLAN.md.

## 0. Project Context (for Claude Code's awareness, even though Phase 1 doesn't touch most of this)

We are building a Windows desktop billing app to replace Vyapar for a retail shop. No purchase module, no inventory/stock tracking — billing, payments, parties, and reporting only. Two roles: **Owner** (full access) and **Salesman** (sale + print label only, cannot edit/delete anything anywhere in the app). The full app has 12 phases; **this document covers Phase 1 only** — scaffolding and authentication. Later phases (sale screen, WhatsApp gate, barcode, reports, backup) are NOT part of this phase and should not be built yet, but the architecture in Phase 1 must not block them.

## 1. Tech Stack (final, do not substitute)

| Layer | Choice |
|---|---|
| Shell | Electron (latest stable) |
| UI | React + TypeScript, built with Vite |
| Local DB | SQLite via `better-sqlite3` |
| Styling | Tailwind CSS |
| Password hashing | `bcrypt` (or `bcryptjs` if native bindings are a packaging concern — decide and note which was used) |
| Packaging (not needed yet, but don't fight it later) | `electron-builder` |

Do not introduce Redux, a backend server, or any network dependency in Phase 1 — this app is entirely local/offline at this stage (WhatsApp and Google Drive come in later phases).

## 2. Folder Structure to Create

```
/app
  /electron          → Electron main process code
    main.ts
    preload.ts
  /src                → React renderer
    /components
    /screens
      LoginScreen.tsx
      OwnerDashboardPlaceholder.tsx
      SalesmanDashboardPlaceholder.tsx
    /auth
      AuthContext.tsx
      RequireRole.tsx        → route guard component
    /db
      db.ts                  → better-sqlite3 connection singleton
      migrations/
        001_init.sql
      migrationRunner.ts
    /types
      user.ts
    App.tsx
    main.tsx
  /electron-builder.yml (placeholder config, not used yet)
  package.json
  tsconfig.json
  vite.config.ts
  tailwind.config.js
CLAUDE.md
PHASE1.md   (this file)
```

## 3. Database — What Phase 1 Needs

Only the `users` table is needed this phase. Use this exact schema (this is a subset of the full app schema — later phases will add `parties`, `sales`, `sale_items`, `payments`, `expenses`, `settings`, `whatsapp_log`, `barcode_labels`, `backup_log`, but **do not create those tables yet** — keep Phase 1's migration scoped to only what it needs):

```sql
-- 001_init.sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'salesman')),
  full_name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Build a small migration runner (`migrationRunner.ts`) that:
- Tracks applied migrations in a `_migrations` table (id, filename, applied_at)
- Runs any `.sql` file in `/src/db/migrations` not yet applied, in filename order
- Is safe to run every app launch (idempotent)

This runner is intentionally built to scale — Phase 2 will drop in `002_*.sql` etc. without changing this runner's code.

## 4. Auth Requirements

- Login screen: username + password fields, single "Login" button, error message area
- On submit: look up user by username, verify with bcrypt, check `is_active = 1`
- On success: store a simple session (React context + in-memory state is enough for Phase 1 — no need for persisted "remember me" sessions yet, confirm with client later if wanted)
- On success: route Owner → `OwnerDashboardPlaceholder`, Salesman → `SalesmanDashboardPlaceholder` (both are just a page saying "Logged in as [name] — [role]" with a Logout button; real dashboards come in Phase 10)
- `RequireRole` component: wraps a route, takes an allowed-roles prop, redirects to login if not authenticated, redirects to an "Access Denied" screen if authenticated but wrong role
- **Critical test case**: a Salesman must not be able to reach the Owner placeholder screen by manually typing a route/URL — this is the thing Phase 2 onward depends on architecturally, so get the guard pattern right now.

## 5. Seed Data (for development/testing only)

Add a seed script (`npm run seed`, or auto-seed on first launch if `users` table is empty) that creates:
- `owner` / `owner123` — role `owner`, full_name "Shop Owner"
- `salesman1` / `sales123` — role `salesman`, full_name "Test Salesman"

Print these credentials to the console on seed so whoever's testing has them handy. This is throwaway dev data — real user management (Owner creating/disabling Salesman logins) is a Phase 12 (Settings) feature, not Phase 1.

## 6. App Shell (minimal, just enough to prove routing works)

- Sidebar nav that changes based on role:
  - Owner sees: Dashboard (placeholder), Logout
  - Salesman sees: Dashboard (placeholder), Logout
  - (Both are intentionally sparse in Phase 1 — Parties, Sale, Reports, etc. are added to the nav in their respective later phases, don't stub them out yet)
- Top bar showing logged-in user's name and role

## 7. Explicitly Out of Scope for Phase 1

Do not build any of the following yet, even as placeholders/stubs, since they belong to specific later phases and premature scaffolding tends to lock in wrong assumptions:
- Parties, Sales, Payments, Expenses, Reports, Settings screens
- Barcode scanning/generation
- WhatsApp integration
- Google Drive backup
- Any tax/discount/split-payment logic

## 8. Acceptance Criteria (Phase 1 is done when all of these are true)

1. `npm run dev` launches the Electron app on Windows (or the dev machine's OS) with hot reload working
2. The `users` table is created automatically on first launch via the migration runner; running the app again does not re-run or duplicate the migration
3. Logging in as `owner` / `owner123` lands on the Owner placeholder screen; logging in as `salesman1` / `sales123` lands on the Salesman placeholder screen
4. Wrong password shows an inline error, does not crash, does not reveal whether the username exists vs password is wrong (generic "Invalid username or password")
5. Manually navigating a Salesman session to the Owner route (e.g. editing the URL/hash if using hash routing) redirects to Access Denied, not the Owner screen
6. Logout clears the session and returns to the Login screen
7. `npm run build` produces a packaged output without errors (doesn't need to be a finished installer yet, just prove the build pipeline works)

## 9. CLAUDE.md — Persistent Project Memory

Create this file at the project root. It should persist across all future phases, so write it to be true for the whole project's life, not just Phase 1.

```markdown
# CLAUDE.md

## Project
Windows desktop billing app replacing Vyapar for a retail shop. Electron + React + TypeScript + SQLite (better-sqlite3). No server, no cloud DB — fully local-first, with Google Drive used only for scheduled backup snapshots (added in Phase 12).

## Roles (enforced everywhere, permanently)
- **Owner**: full access to everything.
- **Salesman**: can create a sale, record Payment-In, quick-add a customer (name+phone only) mid-sale, generate/print barcode labels, log expenses (add only), view their own day's sales total. Cannot edit or delete ANY record anywhere in the app — sales, payments, parties, expenses. This is enforced in the data-access layer, not just hidden in the UI, so a modified frontend cannot bypass it. Any new write operation added in any future phase must go through the same permission-checking wrapper established in Phase 2.

## Explicitly out of scope, permanently
- No purchase module.
- No inventory/stock quantity tracking of any kind.
- No GST/tax fields anywhere.

## Business rules that shape the architecture
- Every **Sale** must be sent via WhatsApp Web to both the customer and the Owner before it can be printed. Print button stays disabled until both sends succeed, or the Owner uses an explicit, logged override.
- **Payment-In is NOT WhatsApp-gated** — record and done, no print gate.
- Every sale line item has a **compulsory discount column** (can be 0, but the field always exists).
- Sales support **split payment** — part Cash + part UPI on a single sale.
- Salesman is allowed to override item price at time of sale.
- **Cash bill retention**: lives in local SQLite for 30 days, then exists only in the Google Drive backup for a further 60 days, then is permanently, irreversibly deleted (no snapshot kept) — 90 days total. Credit sales are exempt from this entirely and are retained until their balance is fully cleared, regardless of age.

## Hardware targets (real models, confirmed)
- Label/receipt printer: Posiflow ShipPro 4-inch (USB/Bluetooth thermal).
- Barcode scanner: Helett HT410 — wired USB, keyboard-wedge/HID, plug-and-play, no driver, configurable suffix (Enter/Tab after scan).

## Tech conventions
- TypeScript everywhere, strict mode on.
- Tailwind for styling, no CSS-in-JS.
- better-sqlite3 for all DB access — synchronous API, no need for async/await on queries.
- All DB writes go through a permission-checking wrapper keyed on the logged-in user's role — established in Phase 2, must be reused (never bypassed with a direct query) in every later phase.
- Migrations live in `/src/db/migrations` as numbered `.sql` files, applied in order, tracked in a `_migrations` table, idempotent on every app launch.

## Phase status
Phase 1 (scaffolding + auth) — see PHASE1.md for full spec.
Phases 2–12 — see PLAN.md for the full roadmap; each phase gets its own PHASE_N.md when it starts.
```

## 10. Prompts to Use With Claude Code

Use these in order. Paste PHASE1.md and CLAUDE.md into the project root first, then start with Prompt 1.

**Prompt 1 — Scaffolding**
```
Read PHASE1.md and CLAUDE.md in this project root fully before doing anything.

Set up the project scaffolding exactly as described in PHASE1.md sections 1–2: Electron + React + TypeScript + Vite + Tailwind, with the folder structure given. Get `npm run dev` launching an empty Electron window with hot reload working before moving on to anything else. Do not build auth or the database yet — this step is scaffolding only. Show me the folder structure when done.
```

**Prompt 2 — Database + Migrations**
```
Now implement section 3 of PHASE1.md: the users table via better-sqlite3, and the migration runner described. The migration runner needs to be reusable for future phases (I'll be adding 002_*.sql, 003_*.sql etc. later), so build it generically — don't hardcode 001_init.sql's contents into the runner logic. Confirm it's idempotent by explaining how you tested running it twice.
```

**Prompt 3 — Auth + Routing**
```
Now implement section 4 of PHASE1.md: the login screen, bcrypt password verification, session handling via React context, and the RequireRole route guard. Make sure a Salesman session cannot reach an Owner-only route even by directly editing the URL/hash — this guard pattern needs to be solid since every future phase's permission model depends on getting this right now. Walk me through how you tested the "Salesman can't reach Owner route" case specifically.
```

**Prompt 4 — Seed Data + App Shell**
```
Implement sections 5 and 6 of PHASE1.md: the dev seed script for the owner/salesman test accounts, and the minimal role-aware app shell (sidebar + top bar) with the two placeholder dashboard screens. Don't add nav items for Parties, Sales, Reports, etc. yet — those come in later phases per section 7's out-of-scope list.
```

**Prompt 5 — Verify Against Acceptance Criteria**
```
Go through every item in PHASE1.md section 8 (Acceptance Criteria) one by one and confirm each passes. For any that don't pass yet, fix them before reporting Phase 1 as complete. Also run `npm run build` and confirm it completes without errors per criterion 7.
```

If Claude Code veers off-spec at any point, the fastest correction prompt is usually:
```
Re-read section [N] of PHASE1.md — what you just built doesn't match [specific requirement]. Fix it to match exactly.
```