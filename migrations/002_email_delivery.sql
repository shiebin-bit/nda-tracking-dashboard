CREATE TABLE IF NOT EXISTS email_job (
  id text PRIMARY KEY,
  local_date date NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('sending', 'submitted', 'failed', 'unknown', 'skipped')),
  delivery_id text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

UPDATE workspace
SET settings = settings || '{"automaticRemindersEnabled":false}'::jsonb
WHERE NOT (settings ? 'automaticRemindersEnabled');

CREATE TABLE IF NOT EXISTS email_delivery (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('test', 'scheduled')),
  local_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('sending', 'submitted', 'failed', 'unknown', 'skipped')),
  recipient_email text NOT NULL,
  cc_email text NOT NULL,
  sender_email text NOT NULL,
  subject text NOT NULL,
  html_content text NOT NULL,
  record_count integer NOT NULL CHECK (record_count >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  message_id text NULL,
  error text NULL,
  attempts integer NOT NULL CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS email_delivery_created_at_idx
  ON email_delivery (created_at DESC);

CREATE TABLE IF NOT EXISTS email_request (
  request_id text PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('test', 'retry')),
  delivery_id text NOT NULL,
  created_at timestamptz NOT NULL
);
