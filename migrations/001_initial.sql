CREATE TABLE IF NOT EXISTS workspace (
  id smallint PRIMARY KEY CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  initialized_at timestamptz NOT NULL,
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1)
);

CREATE TABLE IF NOT EXISTS nda_record (
  id text PRIMARY KEY,
  position bigint NOT NULL UNIQUE,
  version integer NOT NULL CHECK (version >= 1),
  source text NOT NULL CHECK (source IN ('seed', 'manual', 'excel', 'renewal')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  renewed_from_id text NULL REFERENCES nda_record(id) DEFERRABLE INITIALLY DEFERRED,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  fingerprint text NOT NULL
);

CREATE INDEX IF NOT EXISTS nda_record_fingerprint_idx ON nda_record (fingerprint);

CREATE TABLE IF NOT EXISTS history_event (
  id text PRIMARY KEY,
  position bigint NOT NULL UNIQUE,
  nda_id text NULL REFERENCES nda_record(id) DEFERRABLE INITIALLY DEFERRED,
  type text NOT NULL,
  timestamp timestamptz NOT NULL,
  actor text NOT NULL,
  summary text NOT NULL,
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array')
);

CREATE TABLE IF NOT EXISTS restore_archive (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  restored_revision bigint NOT NULL,
  preimage jsonb NOT NULL CHECK (jsonb_typeof(preimage) = 'object')
);

INSERT INTO workspace (id, revision, settings, initialized_at, next_number)
VALUES (
  1,
  0,
  '{"recipientEmail":"","ccEmail":"","senderEmail":"","sendTime":"09:00","timeZone":"Asia/Kuala_Lumpur","reminderDays":[90,60,45,30],"automaticRemindersEnabled":false}'::jsonb,
  now(),
  1
)
ON CONFLICT (id) DO NOTHING;
