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
