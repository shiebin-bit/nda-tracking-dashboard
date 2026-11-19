CREATE SEQUENCE nda_record_reference_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE contract_reference_seq AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE FUNCTION format_display_reference(prefix text, value bigint) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT prefix || lpad(value::text, GREATEST(6, length(value::text)), '0')
$$;

ALTER TABLE nda_record ADD COLUMN reference_code text NULL;
ALTER TABLE contract ADD COLUMN reference_code text NULL;

WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY position, id) AS ordinal
  FROM nda_record
)
UPDATE nda_record record
SET reference_code = format_display_reference('AGR-', ordered.ordinal)
FROM ordered
WHERE record.id = ordered.id;

WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS ordinal
  FROM contract
)
UPDATE contract document
SET reference_code = format_display_reference('DOC-', ordered.ordinal)
FROM ordered
WHERE document.id = ordered.id;

SELECT setval('nda_record_reference_seq', GREATEST((SELECT count(*) FROM nda_record), 1), EXISTS (SELECT 1 FROM nda_record));
SELECT setval('contract_reference_seq', GREATEST((SELECT count(*) FROM contract), 1), EXISTS (SELECT 1 FROM contract));

ALTER TABLE nda_record
  ALTER COLUMN reference_code SET DEFAULT format_display_reference('AGR-', nextval('nda_record_reference_seq')),
  ALTER COLUMN reference_code SET NOT NULL,
  ADD CONSTRAINT nda_record_reference_format CHECK (reference_code ~ '^AGR-[0-9]{6,}$'),
  ADD CONSTRAINT nda_record_reference_unique UNIQUE (reference_code);

ALTER TABLE contract
  ALTER COLUMN reference_code SET DEFAULT format_display_reference('DOC-', nextval('contract_reference_seq')),
  ALTER COLUMN reference_code SET NOT NULL,
  ADD CONSTRAINT contract_reference_format CHECK (reference_code ~ '^DOC-[0-9]{6,}$'),
  ADD CONSTRAINT contract_reference_unique UNIQUE (reference_code);

CREATE OR REPLACE FUNCTION prevent_display_reference_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reference_code IS DISTINCT FROM OLD.reference_code THEN
    RAISE EXCEPTION 'display reference is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER nda_record_reference_immutable
  BEFORE UPDATE OF reference_code ON nda_record
  FOR EACH ROW EXECUTE FUNCTION prevent_display_reference_change();

CREATE TRIGGER contract_reference_immutable
  BEFORE UPDATE OF reference_code ON contract
  FOR EACH ROW EXECUTE FUNCTION prevent_display_reference_change();
