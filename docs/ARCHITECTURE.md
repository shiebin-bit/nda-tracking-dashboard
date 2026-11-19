# Architecture and Data Boundaries

> The current Windows desktop edition uses a sandboxed Electron renderer, a session-protected loopback API, per-user SQLite storage, bundled local LibreOffice and a Windows-protected email credential. See [Windows desktop architecture and operations](WINDOWS_DESKTOP.md). The Docker/PostgreSQL process and recovery descriptions below are historical context for migration from `f51e672`.

## Deployment boundary

The supplied stack is a single local workspace. React calls a same-origin Node HTTP API. Application/database ports bind to `127.0.0.1`; document conversion uses an internal Docker network. There is no authentication service, tenant separation or per-user authorization. `Local user` is an attribution label, not a verified identity.

The app is designed to be unavailable when its API/database is unavailable. It does not fall back to hardcoded records or independent browser storage after a failed request.

## Processes

| Process | Responsibilities |
| --- | --- |
| React browser app | Forms, filters, workflow UI, Excel parsing/export and PDF viewing |
| Node HTTP process | API, transactional stores, static assets, email scheduler and document worker |
| PostgreSQL | Persistent records, concurrency constraints, job reservations and binary file storage |
| Gotenberg / LibreOffice | DOCX-to-PDF conversion; no public host port |
| Backup worker | Independent schedule, `pg_dump`, archive verification, status and retention |

Startup applies unapplied migrations under a PostgreSQL advisory lock, validates/seeds the fixed template, creates the HTTP server, and starts the document/email workers. SIGTERM/SIGINT stop workers and close the pool. A converter failure affects PDF generation, not normal tracking or mail APIs.

## Data model

| Tables | Purpose |
| --- | --- |
| `workspace` | Singleton settings, revision, initialization time and next display number |
| `nda_record` | Stable IDs, editable 26-column fields, version, source, ordering, renewal and soft deletion |
| `history_event` | Timestamped changes and follow-up notes |
| `restore_archive` | Pre-recovery register snapshots |
| `email_job` | One reserved formal task for each Malaysia date |
| `email_delivery`, `email_request` | Result/content snapshots, attempts and request deduplication |
| `contract_template` | Versioned template bytes, tags and checksum |
| `contract` | Mutable draft values, version, Draft/Signed state and tracking/file pointers |
| `contract_version` | Generated values/template snapshot and artifact references |
| `document_artifact` | Generated Word/PDF bytes, names, MIME types and checksums |
| `document_job`, `document_job_item` | Persistent generation tasks, item progress, attempts and lease/retry state |
| `contract_signed_file` | Append-only uploaded PDF bytes, version relationship, checksum and attribution |
| `contract_activity`, `contract_request` | Contract audit events and idempotent request outcomes |
| `schema_migration` | Applied incremental SQL filenames |

Display `No.` values are not primary keys. Legacy duplicate numbers remain separate records. Contract Draft/Signed state is distinct from tracking Pending/Resolved state.

## Write consistency

Tracking writes update the record and History in one transaction. Updates use `expectedVersion`; settings and register recovery use `expectedRevision`. A stale request receives 409 instead of silently overwriting newer state. Renewal resolves the prior record and creates its linked successor atomically.

Contract mutations check draft versions. Operations with a `requestId` use persisted request outcomes to guard against repeated submissions. Keep a UUID stable when retrying the same logical operation; do not reuse it for different data. Signing confirmation validates the generated version, current signed-file association and linked-record differences inside the transaction.

## Document lifecycle

1. Save mutable draft values independently of tracking.
2. Validate all selected drafts, then enqueue a persistent single/batch job and return 202.
3. Claim queued items through leases, render DOCX with Docxtemplater/PizZip, and store the resulting artifact/version.
4. Convert that DOCX through Gotenberg and attach the PDF. A conversion failure retains Word and produces a partial result; it does not pretend the PDF exists.
5. Preview/download/print the saved artifact. ZIP streams successful artifacts and a result manifest.
6. Upload a final signed PDF against a complete version. Previous signed uploads remain immutable.
7. Confirm signed to link/create tracking. Drafts, generated artifacts and uploads alone never become reminder candidates.

Batch limits are 100 contracts plus an aggregate template-byte limit enforced in the store. Jobs are recoverable after interruption. The database trigger rejects updates/deletes to stored signed-file rows; replacement changes the contract pointer and appends another file.

## Reminder lifecycle

Date derivation uses `trunc(Duration * 365)` days and the Malaysia date. Exact saved milestones and expired Pending records become candidates. A daily unique constraint reserves a formal task before sending. The backend saves recipient/content snapshots, attempts, result and Brevo message ID.

Clear provider rejection becomes Failed. Timeout/network interruption or a crash during an uncertain send becomes Needs review, with no automatic resend. Submitted records provider acceptance, not confirmed inbox delivery. Test mail has separate request IDs/results and does not reserve the formal daily slot.

## Recovery boundaries

Register JSON and Saved versions operate on active tracking state. They preserve contracts and independent email records, pause automatic reminders, save a preimage, and reconnect contracts by original tracking IDs only. Recycled agreements block register-wide recovery until restored.

Complete `.dump` files capture all database modules, including binary documents and mail deduplication. Environment secrets and host font files live outside PostgreSQL and are not in those backups. The backup worker validates the archive before reporting success and maintains a separate filesystem status file.

## Security and current limits

The HTTP layer checks allowed Host and same-origin requests, restricts static-file paths, requires JSON for ordinary mutations, limits request sizes and applies CSP/security headers. Signed uploads have a separate bounded multipart parser and PDF validation. These checks support the local deployment; they do not provide login, malware scanning, an electronic signature service, or internet-facing authorization.

Before a shared/server deployment, define authentication, authorization, HTTPS, file access, secret management, backup storage and availability separately. Do not publish the current localhost service directly and assume repository privacy protects the running API.

## Supplier and template extensions

Migrations008 and009 add supplier/project masters, optional links on legacy records, versioned template families and editable drafts. Published template bytes and generated metadata are immutable. Jobs freeze the chosen template, custom values and supplier/project associations before running. EOI shares document/signature storage but never writes an NDA record or reserves a reminder task. PDF templates render fields with PDF-LIB and have no DOCX artifact.

Complete backups include these tables and source binaries. The backup service waits for application readiness, including completed migrations, before validating its initial dump. CC arrays are normalized with legacy single-address compatibility and are frozen in each delivery snapshot.
