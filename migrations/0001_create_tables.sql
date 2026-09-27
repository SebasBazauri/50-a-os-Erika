CREATE TABLE IF NOT EXISTS rsvps (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  attend TEXT NOT NULL CHECK (attend IN ('si', 'no')),
  companions INTEGER NOT NULL DEFAULT 0 CHECK (companions BETWEEN 0 AND 10),
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rsvps_created_at ON rsvps(created_at);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip_hash TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_attempts_ip_time ON admin_login_attempts(ip_hash, attempted_at);
