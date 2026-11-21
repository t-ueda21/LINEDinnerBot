CREATE TABLE group_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  group_id TEXT,
  status TEXT NOT NULL DEFAULT 'unbound' CHECK (status IN ('unbound','candidate','active','paused','left')),
  epoch INTEGER NOT NULL DEFAULT 0,
  history_rev INTEGER NOT NULL DEFAULT 0,
  approved_at_ms INTEGER,
  last_membership_ms INTEGER,
  suggestions_enabled INTEGER NOT NULL DEFAULT 0,
  photos_enabled INTEGER NOT NULL DEFAULT 0,
  push_enabled INTEGER NOT NULL DEFAULT 0,
  push_minute_jst INTEGER NOT NULL DEFAULT 1260 CHECK (push_minute_jst BETWEEN 0 AND 1435 AND push_minute_jst % 5 = 0),
  ai_valid_until_ms INTEGER,
  images_valid_until_ms INTEGER,
  ai_hold_code TEXT,
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);
INSERT INTO group_settings(singleton) VALUES (1);

CREATE TABLE group_claim (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  code_hash TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER,
  candidate_group_id TEXT
);

CREATE TABLE webhook_events (
  event_key TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  reply_used INTEGER NOT NULL DEFAULT 0,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX events_expiry ON webhook_events(expires_at_ms);

CREATE TABLE unsent_messages (
  group_id TEXT NOT NULL,
  message_key TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY(group_id, message_key)
);

CREATE TABLE meal_days (
  group_id TEXT NOT NULL,
  meal_date TEXT NOT NULL,
  dishes_json TEXT CHECK (dishes_json IS NULL OR (json_valid(dishes_json) AND json_array_length(dishes_json) > 0)),
  version INTEGER NOT NULL,
  event_time_ms INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  source_key TEXT,
  photo_key TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(group_id, meal_date)
);
CREATE INDEX meals_source ON meal_days(group_id, source_key);
CREATE INDEX meals_photo ON meal_days(group_id, photo_key);

CREATE TABLE deletion_journal (
  group_id TEXT NOT NULL,
  meal_date TEXT NOT NULL,
  max_removed_version INTEGER NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  PRIMARY KEY(group_id, meal_date)
);

CREATE TRIGGER meal_insert_revision AFTER INSERT ON meal_days
WHEN NEW.dishes_json IS NOT NULL
BEGIN
  UPDATE group_settings SET history_rev = history_rev + 1 WHERE group_id = NEW.group_id;
END;

CREATE TRIGGER meal_update_revision AFTER UPDATE OF version ON meal_days
WHEN NEW.version > OLD.version
BEGIN
  UPDATE group_settings SET history_rev = history_rev + 1 WHERE group_id = NEW.group_id;
  INSERT INTO deletion_journal(group_id, meal_date, max_removed_version, recorded_at_ms)
    SELECT OLD.group_id, OLD.meal_date, OLD.version, NEW.updated_at_ms
    WHERE OLD.dishes_json IS NOT NULL
    ON CONFLICT(group_id, meal_date) DO UPDATE SET
      max_removed_version=MAX(max_removed_version, excluded.max_removed_version),
      recorded_at_ms=MAX(recorded_at_ms, excluded.recorded_at_ms);
END;

CREATE TABLE photo_sessions (
  group_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting','processing','reply_pending','ready')),
  declared_at_ms INTEGER NOT NULL,
  ready_at_ms INTEGER,
  deadline_ms INTEGER NOT NULL,
  photo_key TEXT,
  meal_date TEXT,
  candidate_json TEXT,
  PRIMARY KEY(group_id,actor_key)
);

CREATE TABLE usage_attempts (
  kind TEXT NOT NULL CHECK (kind IN ('recommendation','photo_ai','image_transform')),
  group_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  month_jst TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','succeeded','failed','unknown')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(kind,group_id,target_key)
);
CREATE INDEX usage_month ON usage_attempts(kind,month_jst);

CREATE TABLE recommendation_cache (
  group_id TEXT NOT NULL,
  target_date TEXT NOT NULL,
  history_rev INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  candidates_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY(group_id,target_date)
);

CREATE TABLE push_deliveries (
  group_id TEXT NOT NULL,
  target_date TEXT NOT NULL,
  billing_month_jst TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  history_rev INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_flight','retryable','accepted','stopped','skipped')),
  retry_key TEXT UNIQUE,
  body_json TEXT,
  reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0,1)),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  attempt_owner TEXT,
  lease_until_ms INTEGER,
  deadline_ms INTEGER NOT NULL,
  last_result TEXT,
  PRIMARY KEY(group_id,target_date)
);
CREATE INDEX push_month ON push_deliveries(billing_month_jst);

CREATE TABLE admin_log (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL
);
