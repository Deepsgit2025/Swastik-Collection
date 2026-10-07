-- Phase 12 section 3: an audit trail for the retention/purge job.
--
-- Section 3 says an application log file is acceptable and that this "doesn't
-- need its own DB table". It gets one anyway, for two reasons. Every bug in
-- this project was ultimately diagnosed by reading a table, and a log file
-- beside the executable is invisible to the Owner — whose "wait, where did
-- that old bill go?" is the exact question section 3 says this record exists
-- to answer.
--
-- **It deliberately holds no money and no customer.** Recording a purged
-- bill's total or the party it belonged to would leave a partial copy of the
-- bill behind, which is precisely what "permanently deleted ... no snapshot
-- retained anywhere" rules out. What is kept is enough to say *that* bill #123
-- from that date was removed on that day, and nothing more.
--
-- No foreign key on `sale_id`: the row it refers to is gone by design, which
-- is the whole point of the record.
CREATE TABLE IF NOT EXISTS purge_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL CHECK (action IN ('local_purge', 'drive_snapshot_delete')),
  sale_id INTEGER,               -- set for a local_purge
  sale_created_at TEXT,          -- when that bill was rung up, so it can be placed in time
  drive_file_id TEXT,            -- set for a drive_snapshot_delete
  file_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
