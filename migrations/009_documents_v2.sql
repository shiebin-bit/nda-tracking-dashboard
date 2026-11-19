CREATE TABLE template_family (
  id text PRIMARY KEY,
  family_key text NOT NULL,
  name text NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('nda','eoi')),
  template_format text NOT NULL CHECK (template_format IN ('docx','pdf')),
  active boolean NOT NULL DEFAULT true,
  published_template_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_key)
);

ALTER TABLE contract_template
  ADD COLUMN family_id text NULL REFERENCES template_family(id),
  ADD COLUMN document_type text NOT NULL DEFAULT 'nda' CHECK (document_type IN ('nda','eoi')),
  ADD COLUMN template_format text NOT NULL DEFAULT 'docx' CHECK (template_format IN ('docx','pdf')),
  ADD COLUMN field_schema jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(field_schema)='array'),
  ADD COLUMN editor_snapshot jsonb NULL CHECK (editor_snapshot IS NULL OR jsonb_typeof(editor_snapshot)='object');

INSERT INTO template_family(id,family_key,name,document_type,template_format,published_template_id)
SELECT 'legacy-ffm-nda-family','ffm-nda','FFM NDA · Disclosing party','nda','docx',id
FROM contract_template
WHERE template_key='ffm-nda-v1'
ORDER BY created_at DESC,id DESC LIMIT 1
ON CONFLICT (family_key) DO NOTHING;

UPDATE contract_template SET family_id='legacy-ffm-nda-family'
WHERE template_key='ffm-nda-v1' AND family_id IS NULL;

ALTER TABLE template_family
  ADD CONSTRAINT template_family_published_template_fk
  FOREIGN KEY (published_template_id) REFERENCES contract_template(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE template_draft (
  id text PRIMARY KEY,
  family_id text NOT NULL REFERENCES template_family(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  name text NOT NULL,
  file_name text NOT NULL,
  source_content bytea NOT NULL CHECK (octet_length(source_content) <= 20971520),
  source_checksum text NOT NULL,
  editor_snapshot jsonb NOT NULL CHECK (jsonb_typeof(editor_snapshot)='object'),
  preview_version integer NULL,
  preview_checksum text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id)
);

ALTER TABLE contract
  ADD COLUMN document_type text NOT NULL DEFAULT 'nda' CHECK (document_type IN ('nda','eoi')),
  ADD COLUMN template_family_id text NULL REFERENCES template_family(id),
  ADD COLUMN custom_values jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(custom_values)='object');

UPDATE contract SET template_family_id='legacy-ffm-nda-family'
WHERE document_type='nda' AND template_family_id IS NULL
  AND EXISTS (SELECT 1 FROM template_family WHERE id='legacy-ffm-nda-family');

ALTER TABLE document_job_item
  ADD COLUMN template_format text NOT NULL DEFAULT 'docx' CHECK (template_format IN ('docx','pdf')),
  ADD COLUMN field_schema jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(field_schema)='array'),
  ADD COLUMN editor_snapshot jsonb NULL CHECK (editor_snapshot IS NULL OR jsonb_typeof(editor_snapshot)='object'),
  ADD COLUMN custom_values_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(custom_values_snapshot)='object'),
  ADD COLUMN supplier_id_snapshot text NULL,
  ADD COLUMN project_id_snapshot text NULL,
  ADD COLUMN template_family_id_snapshot text NULL;

ALTER TABLE contract_template DROP CONSTRAINT IF EXISTS contract_template_checksum_key;
CREATE INDEX contract_template_checksum_idx ON contract_template(checksum);

ALTER TABLE contract_version
  ALTER COLUMN docx_artifact_id DROP NOT NULL,
  ADD COLUMN template_format text NOT NULL DEFAULT 'docx' CHECK (template_format IN ('docx','pdf')),
  ADD COLUMN custom_values_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(custom_values_snapshot)='object'),
  ADD COLUMN supplier_id_snapshot text NULL,
  ADD COLUMN project_id_snapshot text NULL,
  ADD COLUMN template_family_id_snapshot text NULL;

CREATE INDEX contract_supplier_project_idx ON contract(supplier_id,project_id,document_type)
  WHERE deleted_at IS NULL;
CREATE INDEX contract_template_family_idx ON contract(template_family_id,created_at DESC);
CREATE INDEX template_family_document_idx ON template_family(document_type,active,name);

CREATE OR REPLACE FUNCTION reject_template_publication_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.family_id IS DISTINCT FROM OLD.family_id
     OR NEW.template_key IS DISTINCT FROM OLD.template_key
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.checksum IS DISTINCT FROM OLD.checksum
     OR NEW.tags IS DISTINCT FROM OLD.tags
     OR NEW.document_type IS DISTINCT FROM OLD.document_type
     OR NEW.template_format IS DISTINCT FROM OLD.template_format
     OR NEW.field_schema IS DISTINCT FROM OLD.field_schema
     OR NEW.editor_snapshot IS DISTINCT FROM OLD.editor_snapshot THEN
    RAISE EXCEPTION 'published template versions are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contract_template_content_protected ON contract_template;
CREATE TRIGGER contract_template_content_protected
  BEFORE UPDATE ON contract_template
  FOR EACH ROW EXECUTE FUNCTION reject_template_publication_mutation();
