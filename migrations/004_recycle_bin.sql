ALTER TABLE nda_record
  ADD COLUMN deleted_at timestamptz NULL,
  ADD COLUMN deleted_by text NULL,
  ADD CONSTRAINT nda_record_deleted_pair CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

ALTER TABLE contract
  ADD COLUMN deleted_at timestamptz NULL,
  ADD COLUMN deleted_by text NULL,
  ADD CONSTRAINT contract_deleted_pair CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

CREATE INDEX nda_record_active_position_idx
  ON nda_record (position) WHERE deleted_at IS NULL;

CREATE INDEX nda_record_recycled_idx
  ON nda_record (deleted_at DESC, id) WHERE deleted_at IS NOT NULL;

CREATE INDEX contract_active_updated_idx
  ON contract (updated_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE INDEX contract_recycled_idx
  ON contract (deleted_at DESC, id) WHERE deleted_at IS NOT NULL;
