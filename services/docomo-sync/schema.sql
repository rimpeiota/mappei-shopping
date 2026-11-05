-- No mailbox addresses, raw headers, subjects, bodies, or credentials are stored.
CREATE TABLE IF NOT EXISTS collector_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  uid_validity TEXT NOT NULL DEFAULT '',
  last_uid INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_error_code TEXT,
  auth_blocked INTEGER NOT NULL DEFAULT 0,
  limited INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO collector_state (id) VALUES (1);
CREATE TABLE IF NOT EXISTS commerce_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  account_scope TEXT NOT NULL,
  payload TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
