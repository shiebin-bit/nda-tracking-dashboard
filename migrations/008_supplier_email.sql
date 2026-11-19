CREATE TABLE IF NOT EXISTS supplier (
  id text PRIMARY KEY,
  supplier_code text NOT NULL CHECK (supplier_code = btrim(supplier_code) AND length(supplier_code) BETWEEN 1 AND 100),
  company_name text NOT NULL CHECK (company_name = btrim(company_name) AND length(company_name) BETWEEN 1 AND 500),
  registration_number text NOT NULL DEFAULT '' CHECK (length(registration_number) <= 500),
  address text NOT NULL DEFAULT '' CHECK (length(address) <= 10000),
  contact_name text NOT NULL DEFAULT '' CHECK (length(contact_name) <= 500),
  contact_designation text NOT NULL DEFAULT '' CHECK (length(contact_designation) <= 500),
  contact_address text NOT NULL DEFAULT '' CHECK (length(contact_address) <= 10000),
  contact_email text NOT NULL DEFAULT '' CHECK (length(contact_email) <= 500),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz NULL,
  deleted_by text NULL,
  CONSTRAINT supplier_deleted_pair CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_code_ci_unique_idx ON supplier (lower(supplier_code));
CREATE INDEX IF NOT EXISTS supplier_active_name_idx ON supplier (lower(company_name), lower(supplier_code)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS project (
  id text PRIMARY KEY,
  project_code text NULL CHECK (project_code IS NULL OR (project_code = btrim(project_code) AND length(project_code) BETWEEN 1 AND 100)),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 500),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz NULL,
  deleted_by text NULL,
  CONSTRAINT project_deleted_pair CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS project_code_ci_unique_idx ON project (lower(project_code)) WHERE project_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_active_name_idx ON project (lower(name), id) WHERE deleted_at IS NULL;

ALTER TABLE nda_record ADD COLUMN IF NOT EXISTS supplier_id text NULL REFERENCES supplier(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX IF NOT EXISTS nda_record_supplier_idx ON nda_record (supplier_id) WHERE supplier_id IS NOT NULL;

ALTER TABLE contract ADD COLUMN IF NOT EXISTS supplier_id text NULL REFERENCES supplier(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE contract ADD COLUMN IF NOT EXISTS project_id text NULL REFERENCES project(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX IF NOT EXISTS contract_supplier_idx ON contract (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contract_project_idx ON contract (project_id) WHERE project_id IS NOT NULL;

ALTER TABLE email_delivery ADD COLUMN IF NOT EXISTS cc_emails text[] NOT NULL DEFAULT '{}';
UPDATE email_delivery SET cc_emails = ARRAY[cc_email] WHERE cc_email <> '' AND cardinality(cc_emails) = 0;

UPDATE workspace
SET settings = jsonb_set(
  settings,
  '{ccEmails}',
  CASE WHEN nullif(btrim(settings->>'ccEmail'),'') IS NULL THEN '[]'::jsonb
       ELSE jsonb_build_array(btrim(settings->>'ccEmail')) END,
  true
)
WHERE NOT (settings ? 'ccEmails');
