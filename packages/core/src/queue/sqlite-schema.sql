-- Pennant Hoist - Multi-Identity Deck & Adaptive Media Engine
-- Copyright (c) 2026 Alan Woodyard <alan@alanwoodyard.com>
-- Licensed under the MIT License.
--
-- SQLite Broadcast Queue & Ledger Schema

CREATE TABLE IF NOT EXISTS broadcast_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'staging', 'dispatched', 'partial', 'failed')),
  scheduled_for TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_broadcast_queue_due 
ON broadcast_queue(status, scheduled_for);

CREATE TABLE IF NOT EXISTS broadcast_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id INTEGER NOT NULL REFERENCES broadcast_queue(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  target_endpoint TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_id TEXT,
  error_message TEXT,
  dispatched_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_broadcast_ledger_queue 
ON broadcast_ledger(queue_id);
