ALTER TABLE contract_version
  ADD CONSTRAINT contract_version_contract_id_id_unique UNIQUE (contract_id, id);

CREATE TABLE contract_signed_file (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES contract(id),
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  source_version_id text NOT NULL,
  original_file_name text NOT NULL CHECK (length(original_file_name) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK (content_type = 'application/pdf'),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL CHECK (octet_length(content) = size_bytes),
  uploaded_by text NOT NULL,
  uploaded_at timestamptz NOT NULL,
  UNIQUE (contract_id, ordinal),
  UNIQUE (contract_id, id),
  CONSTRAINT contract_signed_file_source_version_fk
    FOREIGN KEY (contract_id, source_version_id) REFERENCES contract_version(contract_id, id)
);

CREATE INDEX contract_signed_file_contract_idx
  ON contract_signed_file (contract_id, ordinal DESC);

ALTER TABLE contract
  ADD COLUMN current_signed_file_id text NULL,
  ADD CONSTRAINT contract_current_signed_file_fk
    FOREIGN KEY (id, current_signed_file_id) REFERENCES contract_signed_file(contract_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION reject_contract_signed_file_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'contract signed files are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER contract_signed_file_immutable
  BEFORE UPDATE OR DELETE ON contract_signed_file
  FOR EACH ROW EXECUTE FUNCTION reject_contract_signed_file_mutation();
