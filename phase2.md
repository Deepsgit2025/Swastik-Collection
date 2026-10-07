# PHASE2.md — Database Schema & Core Data Layer

> Self-contained. Assumes Phase 1 is complete (Electron+React+TS+Vite scaffolding, `users` table, auth, migration runner, role guard all working). Read CLAUDE.md first — it has the permanent project rules this phase must enforce.

## 0. What This Phase Is For

Phase 1 only had the `users` table. This phase builds out the **entire rest of the schema** in one migration pass, and — more importantly — builds the **permission-checking wrapper** that every future write operation (Phase 3 onward) must go through. Get this wrapper right now; every later phase depends on it and should never bypass it with a direct query.

No UI screens are built in this phase except a minimal internal test harness to prove the data layer works. Real screens start in Phase 3.

## 1. Full Schema — Migration `002_core_schema.sql`

```sql
-- Parties (customers/credit accounts — no supplier/purchase concept, this app has no purchase module)
CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  balance REAL NOT NULL DEFAULT 0,      -- positive = they owe the shop
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sales (the bill header)
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party_id INTEGER REFERENCES parties(id),   -- nullable: cash sale with no party needed
  salesman_user_id INTEGER NOT NULL REFERENCES users(id),
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('cash', 'upi', 'credit', 'split')),
  cash_amount REAL NOT NULL DEFAULT 0,
  upi_amount REAL NOT NULL DEFAULT 0,
  credit_amount REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL,
  total_discount REAL NOT NULL DEFAULT 0,
  grand_total REAL NOT NULL,
  whatsapp_customer_sent INTEGER NOT NULL DEFAULT 0,
  whatsapp_owner_sent INTEGER NOT NULL DEFAULT 0,
  printed INTEGER NOT NULL DEFAULT 0,
  print_override_used INTEGER NOT NULL DEFAULT 0,
  is_cash_bill INTEGER NOT NULL,       -- 1 if payment_mode has no credit component; drives the 30/60/90 retention rule
  archived_local INTEGER NOT NULL DEFAULT 0,   -- set at day 30 (removed from active local views)
  purge_at TEXT,                        -- computed at creation for cash bills: created_at + 90 days
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sale line items
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  barcode TEXT,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,     -- compulsory field, always present, defaults to 0
  line_total REAL NOT NULL              -- (quantity * unit_price) - discount
);

-- Payments (Payment-In — against a party's outstanding balance, NOT tied to a specific sale necessarily)
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  party_id INTEGER NOT NULL REFERENCES parties(id),
  amount REAL NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('cash', 'upi')),
  note TEXT,
  recorded_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Expenses
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  logged_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Settings (key/value, Owner-only access at the UI layer, built out in Phase 12)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- WhatsApp send log (audit trail for the Phase 6 gate)
CREATE TABLE IF NOT EXISTS whatsapp_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('customer', 'owner')),
  recipient_number TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Barcode labels generated (for reprint/reference, Phase 4)
CREATE TABLE IF NOT EXISTS barcode_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,
  price REAL,
  barcode_value TEXT NOT NULL UNIQUE,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Backup log (Phase 12)
CREATE TABLE IF NOT EXISTS backup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  drive_file_id TEXT,
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('scheduled', 'manual')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Notes for Claude Code:
- `sale_items.discount` must never be nullable and must never be dropped from the schema or any insert statement in any later phase — it's a permanent, compulsory field per CLAUDE.md.
- `sales.is_cash_bill` and `purge_at` exist specifically to drive the Phase 12 retention job — compute `is_cash_bill = (payment_mode != 'credit' AND credit_amount = 0)` and `purge_at = created_at + 90 days` at insert time, even though nothing acts on them until Phase 12. Don't skip populating them now just because they're unused yet — retrofitting this later is more error-prone than doing it at the source.

## 2. The Permission-Checking Wrapper (the core deliverable of this phase)

Build a single module, e.g. `/src/db/permissions.ts`, that every write operation in every future phase routes through. Do not let individual screens/features write their own ad-hoc permission checks — one central place.

Design:

```typescript
type Role = 'owner' | 'salesman';

type Action =
  | 'party:create' | 'party:edit' | 'party:delete'
  | 'sale:create'
  | 'sale:edit' | 'sale:delete' | 'sale:reprint'
  | 'payment:create'
  | 'expense:create' | 'expense:edit' | 'expense:delete'
  | 'settings:edit'
  | 'user:manage'
  | 'backup:run' | 'backup:restore'
  | 'report:view_all' | 'report:view_own';

// central table, not scattered if/else per screen
const PERMISSIONS: Record<Action, Role[]> = {
  'party:create': ['owner', 'salesman'],   // salesman quick-add only, enforced further at the field level in Phase 3
  'party:edit': ['owner'],
  'party:delete': ['owner'],
  'sale:create': ['owner', 'salesman'],
  'sale:edit': ['owner'],
  'sale:delete': ['owner'],
  'sale:reprint': ['owner'],
  'payment:create': ['owner', 'salesman'],
  'expense:create': ['owner', 'salesman'],
  'expense:edit': ['owner'],
  'expense:delete': ['owner'],
  'settings:edit': ['owner'],
  'user:manage': ['owner'],
  'backup:run': ['owner'],
  'backup:restore': ['owner'],
  'report:view_all': ['owner'],
  'report:view_own': ['owner', 'salesman'],
};

function assertPermission(role: Role, action: Action): void {
  if (!PERMISSIONS[action].includes(role)) {
    throw new PermissionError(`Role '${role}' cannot perform '${action}'`);
  }
}
```

Every DB write function (`createSale`, `deleteParty`, `logExpense`, etc., built out in later phases) must call `assertPermission(currentUser.role, 'action:name')` as its first line, before touching SQLite. This is what makes the "Salesman cannot edit/delete anything, even via a modified frontend" rule from CLAUDE.md actually true rather than just a UI convention.

## 3. Seed Data Update

Extend the Phase 1 seed script to add a handful of test parties (2–3, some with a non-zero balance) so Phase 3 onward has something to work against immediately. Do not seed sales/payments/expenses yet — those get real seed data (or none) in their own phases.

## 4. Internal Test Harness (throwaway, dev-only)

Add a temporary dev-only screen or a small script (`npm run test:permissions`) that exercises `assertPermission` against every Action for both roles and prints a pass/fail table. This is not a real feature — it exists purely to prove the wrapper works before Phase 3 starts building real screens on top of it. Fine to delete in a later phase once real screens cover the same ground via their own tests.

## 5. Acceptance Criteria

1. All 9 tables from section 1 exist after migration; `_migrations` shows `002_core_schema.sql` applied exactly once even across repeated app launches
2. `sale_items.discount` is present in the schema and defaults to 0 — confirm by inserting a row without specifying it and checking the stored value
3. `assertPermission('salesman', 'sale:edit')` throws; `assertPermission('salesman', 'sale:create')` does not
4. `assertPermission('owner', <any action>)` never throws for any action in the table
5. The permission test harness (section 4) prints a full pass table for both roles against every action
6. No screen or feature built so far bypasses `assertPermission` with a direct `db.prepare(...)` write call — confirm by searching the codebase for write queries and checking each traces back through the wrapper

## 6. Prompts for Claude Code

**Prompt 1 — Schema Migration**
```
Read PHASE2.md fully, and re-read CLAUDE.md for the permanent project rules. Implement section 1: create migration file 002_core_schema.sql exactly as specified, using the existing migration runner from Phase 1 (don't modify the runner's logic, just add the new migration file). Confirm all 9 tables are created and that 002_core_schema.sql only ever applies once even across repeated launches.
```

**Prompt 2 — Permission Wrapper**
```
Implement section 2 of PHASE2.md: the assertPermission wrapper and the central PERMISSIONS table. This is the single source of truth for role permissions going forward — every write function built in any future phase must call this first. Put it somewhere clearly discoverable (/src/db/permissions.ts) and note in CLAUDE.md-style comments at the top of the file that nothing should bypass it.
```

**Prompt 3 — Seed Data + Test Harness**
```
Implement sections 3 and 4: extend the seed script with 2-3 test parties (include at least one with a non-zero balance), and build the permission test harness described. Run it and show me the pass/fail table for both roles against every action.
```

**Prompt 4 — Verify**
```
Go through PHASE2.md section 5 acceptance criteria one by one and confirm each passes, including criterion 6 — search the codebase for any direct SQLite write that doesn't route through assertPermission and flag it before calling this phase done.
```