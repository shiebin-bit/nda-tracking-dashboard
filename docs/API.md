# HTTP API Reference

Base URL for the default local deployment: `http://127.0.0.1:5183/api`.

This API serves a trusted local workspace. It has no login or API-token authentication. Host/origin checks are enabled; they are not a substitute for authorization. The current source of truth for routing is `server/app.ts`; payload types live in `src/core.ts`, `src/contract-types.ts`, and the client repositories.

## Conventions

- Ordinary POST/PUT/PATCH/DELETE requests require `Content-Type: application/json`, including delete requests with a JSON body.
- The signed-file endpoint uses multipart form data instead. Let the client generate the multipart boundary.
- JSON body limit is 10 MiB. Signed PDF payloads are separately limited to 20 MiB.
- Dates are `YYYY-MM-DD`; timestamps are ISO strings. Scheduling uses `Asia/Kuala_Lumpur`.
- Contract, email, recycle and note operations that take `requestId` expect a UUID. Reuse it only for an identical retry.
- `expectedVersion` is the last record/draft version read. `expectedRevision` is the last workspace revision read.
- Contract generation/batch/retry endpoints return **202** with `{job}`. Other successful JSON routes currently return **200**.
- A normal register mutation returns `{revision, snapshot}`; the snapshot contains `schemaVersion`, `records`, `history`, `settings` and `initializedAt`.

Errors have this shape:

```json
{
  "error": {
    "code": "version_conflict",
    "message": "A human-readable explanation",
    "details": {}
  }
}
```

`details` is optional. Common statuses: 400 invalid input, 403 invalid Origin, 404 missing item/route, 409 stale version or business conflict, 413 body too large, 415 unsupported media type, 421 disallowed Host, and 500 unexpected failure. Preserve server conflict details for the user instead of silently retrying with new values.

## Tracking, history and recovery

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/state` | Register envelope, including History and settings |
| POST | `/records` | `{fields}` |
| PUT | `/records/:id` | `{expectedVersion, fields}` |
| POST | `/records/:id/renew` | `{expectedVersion, fields}`; atomically resolves old record and creates successor |
| POST | `/records/:id/follow-up-notes` | `{expectedVersion, text, requestId}`; note is append-only |
| DELETE | `/records/:id` | `{expectedVersion, requestId}`; recycle, not permanent delete |
| POST | `/imports` | `{rows: Fields[]}`; validate/import register rows |
| PUT | `/settings` | `{expectedRevision, settings}` |
| GET | `/recycle-bin` | `{records, contracts}` |
| POST | `/recycle-bin/records/:id/restore` | `{expectedVersion, requestId}` |
| GET | `/backups/archives` | `{archives}` of saved register preimages |
| POST | `/backups/restore` | `{expectedRevision, snapshot}` |
| POST | `/backups/restore/:id` | `{expectedRevision}` to recover a saved register version |
| GET | `/backups/automatic/status` | Read-only automatic full-backup status |

`Fields` is a map with the original 26 headings. Generated display numbers and derived dates/days are not independent identity or expiry sources. A minimal new register entry uses:

```json
{
  "fields": {
    "Recipient": "Example Supplier Sdn. Bhd.",
    "Date of Agreement": "2026-11-04",
    "Duration": 3,
    "UOM": "years",
    "PIC": "Example PIC",
    "Status": "Pending"
  }
}
```

`Status` is Pending or Resolved. Missing fields normalize according to server validation. Register imports deliberately permit reviewed legacy deficiencies that ordinary form creation rejects. History and follow-up notes are part of `/state`; there is no separate fabricated history feed.

## Email

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/email/status` | Brevo configuration/connection and sender information |
| GET | `/email/summary` | Read-only formal reminder schedule/latest-task summary |
| GET | `/email/deliveries` | `{deliveries}`; recent saved attempts/results |
| POST | `/email/test` | `{recipientEmail, requestId}`; **sends an explicit real test email** |
| POST | `/email/deliveries/:id/retry` | `{requestId}`; may send email according to retry rules |

There is no public manual-run scheduler endpoint. The backend owns the daily reservation. Opening the UI's email preview builds a preview without calling a send endpoint. Never use test/retry calls as a health check.

## Contract templates and drafts

| Method | Path | Body / result |
| --- | --- | --- |
| GET | `/contract-templates` | `{templates}` |
| GET | `/contracts` | `{contracts}` with workflow/list summaries |
| POST | `/contracts` | `{values, requestId}` |
| GET | `/contracts/:id` | `{contract}` including versions, signed-file summaries and activity |
| PATCH | `/contracts/:id` | `{expectedVersion, values}` |
| DELETE | `/contracts/:id` | `{expectedVersion, requestId}` |
| POST | `/contracts/:id/duplicate` | `{requestId}` |
| POST | `/records/:id/contract-draft` | `{requestId}`; linked draft from tracking |
| POST | `/contracts/:id/refresh-from-record` | `{expectedVersion, requestId}` |
| POST | `/contracts/imports/preflight` | `{rows: [{rowNumber, values}]}`; validation only |
| POST | `/contracts/imports` | `{rows: [{rowNumber, values}], requestId}` |
| POST | `/recycle-bin/contracts/:id/restore` | `{expectedVersion, requestId}` |

`ContractValues` contains `discloser`, `recipient`, `purpose`, `agreementDate`, `duration`, `pic` and `department`. Each party contains:

```json
{
  "name": "Example Company",
  "registrationNumber": "EXAMPLE-REG-1",
  "address": "Example company address",
  "contact": {"name": "", "designation": "", "address": "", "email": ""},
  "signatory": {"name": "", "designation": ""},
  "witness": {"name": "", "designation": ""}
}
```

Draft validation permits incomplete values. Generation imposes required fields. The frontend parses the Excel file; the API receives normalized draft rows, not a raw workbook multipart upload.

## Document jobs and artifacts

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/contracts/:id/generations` | `{expectedVersion, requestId}`; 202 `{job}` |
| POST | `/document-jobs/batch` | `{contracts: [{id, expectedVersion}], requestId}`; 202 `{job}`, at most 100 |
| GET | `/document-jobs` | `{jobs}`; active jobs plus recent finished jobs |
| GET | `/document-jobs/:id` | `{job}` with item results |
| POST | `/document-jobs/:id/retry` | `{requestId}`; 202 `{job}` for eligible failed/partial work |
| GET | `/document-jobs/:id/archive` | ZIP containing available files and `manifest.json` |
| GET | `/document-artifacts/:id/content` | Saved DOCX/PDF; `?download=1` requests attachment disposition |

Poll the returned job while active. A partial item can retain a valid Word file with no PDF. Do not label a job complete because its HTTP request was accepted.

## Final signed PDF

`POST /contracts/:id/signed-files` accepts multipart fields:

| Field | Value |
| --- | --- |
| `requestId` | UUID for this upload/retry |
| `expectedVersion` | Current draft version as text |
| `versionId` | Complete generated version belonging to this contract |
| `file` | One `application/pdf` file, at most 20 MiB |

The response is `{contract, signedFile}`. Upload preserves Draft/Signed state and does not create tracking. Replacement adds another immutable file. Signed-file bytes are available through `GET /contract-signed-files/:id/content`; use `?download=1` for download.

`POST /contracts/:id/confirm-signed` requires:

```json
{
  "requestId": "<UUID>",
  "expectedVersion": 2,
  "versionId": "<generated-version-id>",
  "signedFileId": "<current-signed-file-id>",
  "agreementDate": "2026-11-04",
  "pic": "Example PIC"
}
```

It returns `{contract, recordId, revision}`. The file must be the current copy for the selected version/contract. Linked-record mismatches return a conflict with differences for explicit user resolution. The server does not verify handwritten signatures.

## Health outside `/api`

- `GET /health/live`: process liveness
- `GET /health/ready`: PostgreSQL readiness

Neither endpoint sends mail or generates a contract.

## Suppliers and projects

| Method | Path | Behavior |
| --- | --- | --- |
| GET / POST | `/suppliers` | `{suppliers}` / create `{supplier}` |
| GET / PATCH | `/suppliers/:id` | Detail with agreement/document links / update `{supplier}` |
| GET / POST | `/projects` | `{projects}` / create `{project}` |
| PATCH | `/projects/:id` | Update `{project}` |
| POST | `/suppliers/:id/assignments` | Explicit versioned agreement/document group assignment |
| PATCH | `/records/:id/supplier` | `{supplierId, expectedVersion}`; state envelope and History |

Supplier creation accepts `supplierCode`, `companyName`, optional `registrationNumber`, `address` and `contact: {name, designation, address, email}`. Updates include `expectedVersion`. Project creation accepts `name`, optional `projectCode`, `description` and `status` (`active` / `archived`). Codes are text, not numbers. Supplier codes are case-insensitively unique.

Contract creation/update supports `documentType` (`nda` / `eoi`), `supplierId`, `projectId`, `templateFamilyId` and `customValues`, in addition to the existing values. EOI signing returns `recordId: null` and creates no tracking record. PDF-only complete versions have `docxArtifactId: null`.

## Managed templates

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/contract-templates/families` | `{families}` |
| GET | `/contract-template-drafts` | `{drafts}` |
| POST | `/contract-templates/import` | Multipart import; 201 `{family, draft}` |
| PATCH | `/contract-template-drafts/:id` | `{expectedVersion, name, editorSnapshot}`; `{draft}` |
| GET | `/contract-template-drafts/:id/source` | Original DOCX/PDF; optional `?download=1` |
| POST | `/contract-template-drafts/:id/preview` | Sample `values` and `customValues`; binary PDF preview |
| POST | `/contract-template-drafts/:id/publish` | `{requestId, expectedVersion, version, name}`; 201 `{template}` |

Import uses one `file` (DOCX/PDF, maximum 20 MiB), `key` (unique template-family key), `name`, `documentType` and `requestId`. It creates an editable draft, not a published template. Preview must match the current saved draft before publishing. Later draft changes invalidate preview readiness. Published versions and generated files remain immutable.

`editorSnapshot.fields` defines `key`, `label`, `type` (`text`, `number`, `date`), `required` and optional `source`. Word snapshots include protected/editable text `regions`. PDF snapshots include `placements` with `field`, `page` (one-based), `x`, `y`, `width`, `height`, `fontSize`, `align`. Repeated placements can read the same field. Invalid or overflowing placements fail rather than clip.

## Multiple CC compatibility

Settings and delivery responses include `ccEmails: string[]`, with up to ten addresses. Legacy `ccEmail` remains accepted for older backups/clients. Normalization trims, removes duplicates without regard to letter case and excludes the To address. Test submissions always have an empty CC list. Stored deliveries retain the submission's own recipient snapshot.

### Display references and explicit assignments

Agreement and document API resources include `reference` (`AGR-…` / `DOC-…`). They are allocated by the server, unique and immutable; UUID paths and Excel columns remain unchanged. Supplier detail resources include references and document recipient names.

`POST /suppliers/:id/assignments` accepts `{agreements: [{id, expectedVersion}], documents: [{id, expectedVersion}]}`. Include all related active documents/tracking agreements explicitly; omitted related items return `409 related_items_required`. Changes apply in one transaction; stale versions or recycled targets abort the group. The operation changes supplier associations and records audit events without editing document bytes, contract values, agreement fields or reminder settings. Already assigned targets are no-ops, including a response-lost replay.


## Document naming settings and template history

- `GET /api/document-settings` returns `{revision, settings: {filenameFields}}`.
- `PUT /api/document-settings` accepts `{expectedRevision, settings: {filenameFields}}`. Fields are a unique ordered subset of `type`, `supplier`, `project`, `date`; an empty subset is valid. The reference/version suffix is mandatory. Stale updates return `409 revision_conflict`.
- `GET /api/document-artifacts/:id/content?download=1&versionId=<id>` binds naming to that exact generated version. The version must reference the artifact. This matters when retry versions share a Word artifact. The response supplies UTF-8 `Content-Disposition` and an ASCII fallback; bytes remain unchanged.
- `GET /api/contract-templates/families/:id/versions` returns `{templates}` including earlier inactive published versions.
- `GET /api/contract-templates/:id/source?download=1` reads immutable template bytes.
- `POST /api/contract-templates/:id/preview` accepts optional sample `values`/`customValues` and returns a PDF without changing any draft preview state.
- `POST /api/contract-templates/families/:id/draft` accepts `{requestId, templateId, expectedVersion, confirmReplace}`. Existing drafts require their revision and explicit `confirmReplace: true`; a missing draft requires `expectedVersion: null`. Replays are idempotent. A reset invalidates preview readiness.
- Draft preview requests may include `expectedVersion`; current UI always supplies it. A concurrent edit invalidates the preview even for older clients.
- Template field definitions optionally contain `appearance: {fontWeight: "bold" | "normal"}`. Supplier and project display IDs remain forbidden generation sources.

SQLite workspace version 2 adds document naming preferences and the published-template delete guard. Upgrade validates the exact v1 schema and retains a verified pre-upgrade backup. Complete restore explicitly accepts verified v1 backups, upgrades a disposable staging copy, verifies v2 and pauses automatic reminders before replacement. The selected backup file is never modified.

### Controlled Word structure edits

DOCX `editorSnapshot` optionally includes `wordStructure.rows` (server-derived row metadata) and `wordOperations`. Each operation has a unique `id` and one of these shapes:

```typescript
{type: 'insert-paragraph', anchorId: string, position: 'before' | 'after', text: string}
{type: 'delete-paragraph', targetId: string}
{type: 'insert-table-row', anchorRowId: string, position: 'before' | 'after', cells: string[]}
{type: 'delete-table-row', targetRowId: string}
```

Anchors refer to the immutable draft source. Inserted text remains in operations rather than being submitted as invented source regions. Every original region must be submitted exactly once, including deleted regions. Server inspection supplies protection and row metadata; client flags do not authorize an edit. Only eligible body paragraphs and simple top-level rows may be changed; protected content and deletion of the last original row are rejected. Structural requests use the existing draft PATCH, revision checks and preview/publish flow. Legacy snapshots without operations remain compatible.

Publishing bakes operations into new immutable DOCX bytes and rebases the published snapshot. Copying a published version into a working draft inspects those bytes with no pending operations. This JSON extension requires no additional SQL migration.
