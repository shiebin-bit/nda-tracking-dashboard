CREATE TABLE IF NOT EXISTS contract_template (
  id text PRIMARY KEY,
  template_key text NOT NULL,
  template_version text NOT NULL,
  name text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  content bytea NOT NULL CHECK (octet_length(content) <= 20971520),
  checksum text NOT NULL,
  tags jsonb NOT NULL CHECK (jsonb_typeof(tags) = 'array'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_key, template_version),
  UNIQUE (checksum)
);

CREATE UNIQUE INDEX IF NOT EXISTS contract_template_one_active_key_idx
  ON contract_template (template_key) WHERE active;

CREATE TABLE IF NOT EXISTS contract (
  id text PRIMARY KEY,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'signed')),
  values jsonb NOT NULL CHECK (jsonb_typeof(values) = 'object'),
  linked_nda_id text NULL REFERENCES nda_record(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  linked_nda_historical_id text NULL,
  signed_version_id text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  signed_at timestamptz NULL,
  CHECK ((status = 'draft' AND signed_version_id IS NULL AND signed_at IS NULL)
      OR (status = 'signed' AND signed_version_id IS NOT NULL AND signed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS contract_one_draft_per_linked_nda_idx
  ON contract (linked_nda_historical_id) WHERE status = 'draft' AND linked_nda_historical_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS contract_activity (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  type text NOT NULL,
  actor text NOT NULL,
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS contract_activity_contract_idx
  ON contract_activity (contract_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS document_job (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'partial', 'failed')),
  lease_owner text NULL,
  lease_until timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS document_job_item (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES document_job(id) ON DELETE CASCADE,
  contract_id text NOT NULL REFERENCES contract(id),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'partial', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  values_snapshot jsonb NOT NULL CHECK (jsonb_typeof(values_snapshot) = 'object'),
  template_id text NOT NULL,
  template_key text NOT NULL,
  template_version text NOT NULL,
  template_checksum text NOT NULL,
  template_file_name text NOT NULL,
  template_bytes bytea NOT NULL CHECK (octet_length(template_bytes) <= 20971520),
  version_id text NULL,
  docx_artifact_id text NULL,
  pdf_artifact_id text NULL,
  error_code text NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS document_job_item_claim_idx
  ON document_job_item (status, created_at, id);

CREATE TABLE IF NOT EXISTS document_artifact (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES contract(id),
  kind text NOT NULL CHECK (kind IN ('docx', 'pdf')),
  file_name text NOT NULL,
  content_type text NOT NULL,
  content bytea NOT NULL CHECK (octet_length(content) <= 20971520),
  checksum text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS contract_version (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES contract(id),
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  template_id text NOT NULL,
  template_key text NOT NULL,
  template_version text NOT NULL,
  template_checksum text NOT NULL,
  template_bytes bytea NOT NULL CHECK (octet_length(template_bytes) <= 20971520),
  values_snapshot jsonb NOT NULL CHECK (jsonb_typeof(values_snapshot) = 'object'),
  docx_artifact_id text NOT NULL REFERENCES document_artifact(id),
  pdf_artifact_id text NULL REFERENCES document_artifact(id),
  created_at timestamptz NOT NULL,
  UNIQUE (contract_id, ordinal)
);

ALTER TABLE contract
  ADD CONSTRAINT contract_signed_version_fk
  FOREIGN KEY (signed_version_id) REFERENCES contract_version(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE document_job_item
  ADD CONSTRAINT document_job_item_version_fk FOREIGN KEY (version_id) REFERENCES contract_version(id),
  ADD CONSTRAINT document_job_item_docx_fk FOREIGN KEY (docx_artifact_id) REFERENCES document_artifact(id),
  ADD CONSTRAINT document_job_item_pdf_fk FOREIGN KEY (pdf_artifact_id) REFERENCES document_artifact(id);

CREATE TABLE IF NOT EXISTS contract_request (
  request_id text PRIMARY KEY,
  action text NOT NULL,
  payload_hash text NOT NULL,
  response_status integer NULL,
  response_body jsonb NULL,
  created_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION reject_contract_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'contract versions are immutable' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS contract_version_immutable ON contract_version;
CREATE TRIGGER contract_version_immutable
  BEFORE UPDATE OR DELETE ON contract_version
  FOR EACH ROW EXECUTE FUNCTION reject_contract_version_mutation();

CREATE OR REPLACE FUNCTION reject_document_artifact_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document artifacts are immutable' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS document_artifact_immutable ON document_artifact;
CREATE TRIGGER document_artifact_immutable
  BEFORE UPDATE OR DELETE ON document_artifact
  FOR EACH ROW EXECUTE FUNCTION reject_document_artifact_mutation();

CREATE OR REPLACE FUNCTION protect_contract_template_content() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.template_key IS DISTINCT FROM OLD.template_key
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.checksum IS DISTINCT FROM OLD.checksum
     OR NEW.tags IS DISTINCT FROM OLD.tags
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'contract template content is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contract_template_content_immutable ON contract_template;
CREATE TRIGGER contract_template_content_immutable
  BEFORE UPDATE ON contract_template
  FOR EACH ROW EXECUTE FUNCTION protect_contract_template_content();

CREATE OR REPLACE FUNCTION protect_contract_historical_link() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.linked_nda_historical_id IS NOT NULL
     AND NEW.linked_nda_historical_id IS DISTINCT FROM OLD.linked_nda_historical_id THEN
    RAISE EXCEPTION 'contract historical NDA link is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contract_historical_link_immutable ON contract;
CREATE TRIGGER contract_historical_link_immutable
  BEFORE UPDATE ON contract
  FOR EACH ROW EXECUTE FUNCTION protect_contract_historical_link();

CREATE OR REPLACE FUNCTION relink_contract_to_restored_nda() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contract
  SET linked_nda_id = NEW.id
  WHERE linked_nda_id IS NULL AND linked_nda_historical_id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contract_relink_exact_nda ON nda_record;
CREATE TRIGGER contract_relink_exact_nda
  AFTER INSERT ON nda_record
  FOR EACH ROW EXECUTE FUNCTION relink_contract_to_restored_nda();
