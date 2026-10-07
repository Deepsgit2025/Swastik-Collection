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
