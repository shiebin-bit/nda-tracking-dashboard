<p align="center">
  <img src="docs/brand/nda-tracker.svg" alt="NDA Tracker logo" width="112">
</p>

<h1 align="center">NDA Tracker</h1>

<p align="center">
  A contract preparation and NDA tracking workspace for generating agreements, keeping signed copies, monitoring expiry, and sending daily email reminders.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-19-149ECA?style=for-the-badge&logo=react&logoColor=white" alt="React 19">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript 5.9">
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL 16">
  <img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker ready">
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#workspace-preview">Preview</a> ·
  <a href="docs/USER_GUIDE.zh-CN.md">中文使用说明</a> ·
  <a href="docs/DEVELOPMENT.md">Developer Guide</a> ·
  <a href="docs/API.md">API Reference</a>
</p>

## Why This Project Exists

Preparing an NDA and following it up often involves an Excel register, a Word template, a folder of signed PDFs, and a separate reminder flow. NDA Tracker brings those steps into one local workspace.

Users select an NDA or EOI template, prepare documents, generate files and keep the final signed PDF. Confirming an NDA starts or links expiry tracking; confirming an EOI stores its signing status independently. Supplier IDs and projects connect related documents. The backend checks NDA expiry dates and sends a daily digest through Brevo to the configured recipient, including Outlook or university mailboxes. Power Automate and Microsoft Entra registration are not required for this email path.

## What It Covers

- Agreement overview with expiry counts, follow-up status, search, PIC and department filters, and pagination
- Contracts workspace with draft editing, copying, workflow stages, and a suggested next action
- Versioned FFM NDA generation as Word and PDF
- Separate storage for generated files and final signed PDF copies
- Per-contract signed-copy upload, replacement history, preview, download, and print
- Manual signing confirmation that links or creates a tracking record without duplicate registration
- Excel register import with row validation, duplicate detection, and review before saving
- Excel export of all agreements or all filtered matches across pages, preserving the original 26 columns
- Excel contract-draft import and batch generation of up to 100 agreements with progress and ZIP output
- Editable reminder milestones, exact-day alerts, and daily reminders for expired Pending agreements
- Brevo connection checks, explicit test emails, reminder previews, delivery records, and failure handling
- Agreement history, append-only follow-up notes, renewal links, and optimistic version checks
- Recoverable deletion for agreements and contracts
- PostgreSQL persistence, register-only JSON recovery, and automatic complete database backups
- Docker Compose setup with local application/database ports and an internal PDF conversion service
- Stable website references for agreements (`AGR-000001`) and documents (`DOC-000001`), including existing records
- Supplier IDs and shared projects, with explicit assignment of existing agreements/documents and review of linked groups
- Versioned template drafts: DOCX paragraph/cell editing and fixed-layout PDF field placement
- Up to ten CC recipients for the daily reminder digest

## Workspace Snapshot

| Workspace | Main responsibility |
| --- | --- |
| **Overview** | Find agreements needing attention; search, filter, export Excel, and inspect reminder status |
| **Documents** | Choose a template through New document, prepare drafts, keep signed copies, and confirm NDAs into tracking |
| **Suppliers** | Maintain internal supplier codes and shared projects; find linked agreements and project documents |
| **Templates** | Import DOCX/PDF, edit text or field positions, preview and publish immutable versions |
| **Input** | Register, edit, and renew tracking records using the original Excel fields |
| **History** | Review record changes, imports, renewals, notes, settings changes, and recovery activity |
| **Settings** | Configure reminder recipients, CC, check time, milestone days, email delivery, and backups |
| **Recycle bin** | Restore deleted agreements or contracts while retaining their history and files |

## Workspace Preview

These screenshots use an isolated demonstration dataset captured on 27 October 2026. Reminder sending was disabled in that copy. They are illustrative screens, not a live view of the current database.

### Agreement overview

![Agreement overview with expiry counts, filters and reminder status](docs/screenshots/overview.png)

### Contract preparation

![Contract draft with agreement fields and the generation workflow](docs/screenshots/contract-draft.png)

### Batch generation

![Completed batch job with document results and a ZIP download](docs/screenshots/batch-generation.png)

## Agreement Workflow

```mermaid
flowchart LR
    T[New document: choose a published template] --> A[Enter details or import Excel drafts]
    A --> B[Save draft]
    B --> C[Generate Word and PDF]
    C --> D[Review, download or print]
    D --> E[Collect signatures outside the system]
    E --> F[Upload complete signed PDF]
    F --> G[Review and confirm signed]
    G --> H[Link or create Pending tracking record]
    H --> I[Monitor expiry and follow up]
    I --> J[Resolve or renew]
```

### Drafts, versions and signed copies

- FFM company, contact, signatory and witness defaults are editable for each draft. Client details start empty.
- Drafts can be incomplete. Generation requires both companies' names, registration numbers and addresses, a Purpose, and a valid Duration. Unknown personnel and dates can stay blank at generation time.
- Each generation preserves its values and document version. Changing a draft does not rewrite previously generated files.
- A signed-copy upload accepts one complete PDF of up to **20 MiB**, associated with a complete generated version. Uploading alone leaves the contract as Draft.
- New signing confirmations require the current signed file, agreement date and PIC. Confirmation creates or links the tracking record transactionally. Repeated confirmation requests do not create duplicate tracking records.
- Existing Signed agreements without an attached file show **Signed · File missing**. A later attachment does not create another tracking record.
- Replacing a signed copy preserves the previous upload. It does not change the tracking dates, Duration or follow-up status.
- When a draft is linked to an existing record and values differ, the user must resolve the difference explicitly. The system does not silently overwrite the record or reopen a Resolved agreement.

Signatures are checked by the user. The application does not provide electronic signing, recognize signature fields, or verify signature authenticity. Word edits made after downloading do not synchronize back to the website.

## Reminder Rules

| Rule | Current behavior |
| --- | --- |
| Time zone | `Asia/Kuala_Lumpur` (UTC+8) |
| Default daily check | **09:00 MYT**, configurable in Settings |
| Default milestones | **90, 60, 45, 30** days before expiry, configurable positive distinct integers |
| Eligible records | Active **Pending** records at an exact milestone, or with fewer than 0 days remaining |
| Expired Pending | Included in the daily digest until resolved or recycled |
| Resolved | Excluded from reminders |
| Due today (0 days) | Displayed as Due today; not an email candidate under the current rule |
| Missing or invalid date/Duration | Excluded until corrected |
| Empty candidate list | Recorded as No reminders due; no email is sent |
| Restart after the scheduled time | Processes today's unhandled task; does not replay past dates |

The worker checks on startup and every minute. PostgreSQL stores the daily task and delivery history with a unique local-date constraint to guard against duplicate daily submission. Explicit failures can be retried through Settings; uncertain results caused by timeouts or interruption are marked **Needs review** and are not automatically resent.

**Submitted** means Brevo accepted the request. Actual delivery must be checked in the mailbox or Brevo logs. Test emails have a `[TEST]` subject, contain example content, omit CC, and do not consume the daily reminder task.

The browser can be closed while reminders run. **The computer and Docker must remain running.** A GitHub repository alone does not host the application or keep its scheduler online.

### Date calculation

The current register preserves the original spreadsheet convention:

```text
durationDays   = trunc(Duration × 365)
expiryDate     = agreementDate + durationDays
remainingDays  = expiryDate - today's Malaysia date
```

This supports positive fractional years. It is a fixed-day rule, not a calendar-year anniversary calculation. Remaining days are derived from the current date; no daily counter needs to be manually updated. Excel export writes a fixed snapshot for the export day.

## Stack

### Frontend

- React 19 and TypeScript 5.9
- Vite 8
- Lucide icons and responsive CSS
- ExcelJS for workbook import/export
- Browser-native PDF preview and printing

### Backend

- Node.js 22 container runtime and TypeScript
- Native Node HTTP server
- PostgreSQL 16 with `pg`
- Docxtemplater and PizZip for DOCX generation
- Busboy for signed-PDF multipart uploads
- Yazl for streaming batch ZIP downloads
- Brevo transactional email API

### Infrastructure and verification

- Docker and Docker Compose
- Gotenberg 8 / LibreOffice for internal DOCX-to-PDF conversion
- Read-only Times New Roman font mounts from the Windows host
- Separate PostgreSQL backup worker
- Vitest unit and PostgreSQL integration tests
- GitHub Actions checks for tests, builds, and container buildability

## Architecture

```mermaid
flowchart TB
    Browser[Browser: React workspace] -->|127.0.0.1:5183| App[Node HTTP API and background workers]
    App --> DB[(PostgreSQL 16)]
    DataGrip[Optional DataGrip connection] -->|127.0.0.1:5433| DB
    App -->|DOCX| Converter[Gotenberg / LibreOffice: internal network]
    Converter -->|PDF| App
    App -->|HTTPS| Brevo[Brevo transactional email API]
    Brevo --> Inbox[Configured recipient and optional CC]
    Backup[Independent backup worker] -->|pg_dump| DB
    Backup --> Files[Local automatic backup files]
    Files -->|Read-only status access| App
```

The application owns the record APIs, document job worker and email scheduler. PostgreSQL holds agreements, history, templates, contract snapshots, generated DOCX/PDF binaries, uploaded signed PDFs, and mail records. The converter has no published host port and is isolated on the internal documents network.

Local access is the current deployment boundary. There is no account system or role-based authorization; activity attribution is **Local user**. Host/origin checks and local port binding do not replace authentication. Public or multi-user deployment needs a separate access-control design.

Repository layout:

```text
nda-tracking-dashboard/
├── .github/workflows/     # CI tests and container build checks
├── docs/                 # Guides, architecture, API and demo screenshots
├── migrations/           # Ordered, incremental PostgreSQL migrations
├── scripts/              # Windows startup, backups and template preparation
├── server/               # HTTP API, stores, document/email/backup workers
├── src/                  # React UI, shared types, rules and Excel handling
├── templates/            # Fixed versioned FFM DOCX and integrity metadata
├── tests/fixtures/       # Anonymized legacy-workbook compatibility cases
├── .env.example          # Configuration names with no real credentials
├── compose.yaml
├── Dockerfile
├── Dockerfile.backup
└── package.json
```

## Current State

The local Docker workflow is implemented: contract preparation, document generation, final-PDF storage, manual signing confirmation, NDA tracking, reminders, history and recovery.

Fresh installations create an **empty register** and seed the FFM NDA and EOI templates. The repository does not recreate the original Excel records or import demonstration data on startup. Test fixtures are not runtime seeds.

Current limits:

- DOCX editing preserves document structure; arbitrary Word layout editing and OCR are not included
- Manual signature confirmation; no electronic signature service
- One configured recipient and up to ten optional CC addresses per digest
- Local trusted access with no accounts or individual user attribution
- Windows font mounts in the supplied Compose file; other operating systems need equivalent licensed font paths
- Local backups need separate off-device protection
- No cloud deployment or public URL is supplied by this repository

## Quick Start

### 1. Requirements

- Git and access to this repository
- Windows with Docker Desktop running Linux containers and Docker Compose v2
- Times New Roman at `C:/Windows/Fonts/times.ttf`, `timesbd.ttf`, `timesbi.ttf`, and `timesi.ttf`
- Available local ports **5183** and **5433**
- Internet access for the first image build; a Brevo account/API key only if email is needed

Node.js is optional for Docker-only operation. Development requires Node.js **22.12+** compatible with the locked dependencies.

### 2. Clone and start

```powershell
git clone https://github.com/shiebin-bit/nda-tracking-dashboard.git
cd nda-tracking-dashboard
.\OPEN-NDA-DASHBOARD.cmd
```

On first use, the launcher creates `.env` with a random database password, builds and starts `app`, `db`, `converter`, and `backup`, waits for readiness, then opens the browser. To keep the browser closed:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Start-Dashboard.ps1 -NoBrowser
```

Open **http://127.0.0.1:5183**. A fresh database has no agreements and automatic email is off. Add tracking records through Input or import Excel; prepare contracts from Contracts.

For manual configuration, copy `.env.example` to `.env`, replace the password placeholder with a long random hexadecimal value, then run:

```powershell
docker compose up -d --build --wait --wait-timeout 180
docker compose ps
```

Do not replace an existing `.env` during an upgrade. Changing `NDA_DB_PASSWORD` in the file does not rotate an initialized PostgreSQL password. See [Operations](docs/OPERATIONS.md) for configuration and recovery.

### 3. Configure email when ready

1. Add `BREVO_API_KEY` to the local `.env`. Keep the database password intact.
2. Recreate the application to load runtime configuration:

   ```powershell
   docker compose up -d --build --wait app
   ```

3. In Settings, check the Brevo connection and save a verified sender.
4. Use an explicit test recipient for a `[TEST]` email, then check its mailbox.
5. Save the real recipient, optional CC, daily check time and reminder milestones.
6. Enable automatic reminders and save preferences.

The NDA **Recipient** field identifies a client company. It is not used as the reminder destination. The reminder mailbox comes from Settings.

### 4. Stop without deleting data

```powershell
.\STOP-NDA-DASHBOARD.cmd
```

This stops the project's containers while retaining the database volume. Do not use `docker compose down -v` for ordinary shutdown; it removes the stored database.

### Optional DataGrip connection

| Setting | Value |
| --- | --- |
| Driver | PostgreSQL |
| Host | `127.0.0.1` |
| Port | `5433` |
| Database | `nda_tracker` |
| User | `nda_app` |
| Password | Local `.env` value of `NDA_DB_PASSWORD` |

## Data, Backups and Recovery

- **Database volume:** `nda_pgdata` under the `nda-tracker` Compose project. Rebuilding the application does not reset records.
- **Automatic complete backup:** first backup on initialization, then daily at **02:00 MYT**, retaining **14 successful automatic backups** in `backups/automatic/`. Failed attempts retry after approximately 15 minutes.
- **Manual complete backup:** run `BACKUP-DATABASE.cmd`; files are saved under `backups/`.
- **Register JSON / Saved versions:** active NDA register, History and reminder settings only. Contracts, signed files and the mail ledger stay independent. Restoring register data pauses automatic reminders.
- **Recycle bin:** agreements and contracts are managed separately. Recycling a contract alone does not stop its linked agreement's reminders. Recycling an agreement excludes it from future checks.

Complete PostgreSQL backups include contracts and binary files. Neither complete database backups nor register JSON contains `.env` or the Brevo API key. Keep runtime configuration separately. For a full recovery, use an isolated empty database and verify the result before reconnecting the application. Detailed procedures are in the [Operations Guide](docs/OPERATIONS.md).

## Testing

Unit tests and production compilation:

```powershell
npm ci
npm test
npm run build
```

PostgreSQL integration tests require an explicitly configured **disposable test database**:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://nda_test:local_test_password@127.0.0.1:55433/nda_tracker_test'
npm run test:integration
Remove-Item Env:TEST_DATABASE_URL
```

See the [Developer Guide](docs/DEVELOPMENT.md) for creating and removing that database container. Without `TEST_DATABASE_URL`, integration suites are skipped. Do not point tests at your working register database.

Coverage includes date/milestone boundaries, Excel safety and duplicate handling, version conflicts, atomic renewal, follow-up notes, email scheduling and uncertain outcomes, document job recovery, signed-file validation and confirmation, and recycle-bin restoration.

Feature checks on **18 November 2026** passed: **128 unit tests**, **52 PostgreSQL integration tests**, and client/server production compilation. The latest isolated checks covered reference backfilling and preservation, atomic Supplier classification, reassignment, and template-first document creation on desktop and mobile. Previous checks covered EOI signing without tracking, NDA tracking, duplicate confirmation, Supplier ID exclusion, PDF-only signing, rotated PDF fields, and rendered EOI pages.

### Dependency status

On **17 November 2026**, `npm audit --omit=dev` reported **zero advisories** for the installed production dependency graph. Recheck the audit when upgrading dependencies; a passing build is not a security clearance for a public deployment.

## CI

[ci.yml](.github/workflows/ci.yml) runs unit tests, PostgreSQL integration tests, the client/server build, and both Docker image builds for pushes and pull requests targeting `main`. It uses a disposable PostgreSQL service and no Brevo credentials. PDF conversion in store integration tests uses a local test service; CI does not claim a full visual LibreOffice or physical printing check.

The workflow verifies the repository; it does not deploy the dashboard or publish an image.

## Documentation

- [中文使用说明](docs/USER_GUIDE.zh-CN.md)
- [Operations and Troubleshooting](docs/OPERATIONS.md)
- [Developer Setup and Verification](docs/DEVELOPMENT.md)
- [Architecture and Data Boundaries](docs/ARCHITECTURE.md)
- [HTTP API Reference](docs/API.md)
- [Template Preparation and Integrity](templates/README.md)
- [Suppliers, Projects, EOI and Template Editing](docs/SUPPLIERS_AND_TEMPLATES.md)

## Repository Notes

- Real `.env` values, database exports, runtime records, signed agreements, generated files, local recordings, browser traces, and dependency/build directories are excluded from Git.
- The included compatibility fixture is anonymized and is loaded by tests only.
- The FFM template and editable company defaults are project-specific materials. No open-source license is supplied for this repository.
- Screenshots use demonstration records. A paused or unconfigured email connection in those images describes the isolated demo, not an email delivery result.
- Before sharing diagnostic logs, remove credentials, email addresses, client information and contract content.
