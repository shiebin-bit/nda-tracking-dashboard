# FFM NDA template

This directory contains the fixed versioned DOCX used by Contracts. It is project-specific material, not an arbitrary Word-upload editor.

## Files

- `ffm-nda-v1.docx`: the prepared DOCX package with flat Docxtemplater fields.
- `template-map.json`: field tags, occurrence counts, source hash, structural checks and hashes of the package parts.

On startup, `seedContractTemplates()` validates the package against the metadata and registers the template in PostgreSQL. This seeds the template only, not contracts or NDA records. Generation copies template bytes and values into immutable document snapshots.

## Preparing a revised template

The private original Word master is deliberately not included. The optional preparation script requires Python 3 and `lxml`; neither Python nor the original master is needed to run the dashboard with the committed template.

```powershell
python -m pip install lxml
python scripts/build-contract-template.py --source "C:/private/approved-master.docx" --output "work/revised-template.docx" --map "work/revised-template-map.json"
```

The script applies replacements at known positions in the specific FFM master. It is not a generic parser for other agreement layouts. Do not overwrite the deployed template in place as a routine document edit. A new template revision needs an explicit versioning change, matching package metadata and visual review before deployment.

Check every rendered page: repeated company details, cover, Schedule, contact/signatory/witness roles, blank fields, long addresses, fractional Duration, special characters, tables, cross-references, page numbering, signature spaces and stamp areas. Original Word page-count metadata is not evidence of final PDF layout.

## Fonts and boundaries

Gotenberg mounts Times New Roman from the Windows host. Fonts are not committed. On another operating system, provide licensed equivalents and adjust the Compose mount paths before running the converter.

The template and the editable FFM defaults in `src/contract-core.ts` are organization-specific. Runtime client records and signed agreements belong in PostgreSQL and remain outside Git.
