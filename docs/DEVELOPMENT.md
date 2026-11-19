# Developer Guide

> Desktop development now requires Node.js 24. Use `npm run desktop:dev`, `npm run desktop:prepare` and `npm run desktop:dist`; see [Windows desktop build instructions](WINDOWS_DESKTOP.md). Runtime persistence is SQLite. Docker/PostgreSQL details below describe the earlier edition and its migration source.

## Requirements

- Node.js 22.12+ and npm compatible with the lockfile
- Docker Desktop / Docker Engine and Compose v2
- Git
- Windows Times New Roman files for the supplied converter deployment

Python 3 with `lxml` is optional and used only to prepare a new template from the private original master.

## Install and build

```powershell
npm ci
npm test
npm run build
```

Build output is `dist/public` for the browser and `dist/server` for compiled server/shared modules. `npm start` runs `dist/server/server/index.js`; the working directory must remain the repository root so `migrations/` and `templates/` can be found.

## Disposable development database

Use a separate database from your working NDA register. This example publishes only a local test port and stores PostgreSQL data in disposable tmpfs:

```powershell
docker run -d --name nda-dev-db --tmpfs /var/lib/postgresql/data -e POSTGRES_DB=nda_tracker_dev -e POSTGRES_USER=nda_dev -e POSTGRES_PASSWORD=local_development_password -p 127.0.0.1:55432:5432 postgres:16-alpine
docker exec nda-dev-db pg_isready -U nda_dev -d nda_tracker_dev
```

Wait for readiness before starting the server. In terminal 1:

```powershell
$env:DATABASE_URL = 'postgresql://nda_dev:local_development_password@127.0.0.1:55432/nda_tracker_dev'
$env:PORT = '3000'
$env:NDA_ALLOWED_HOSTS = '127.0.0.1:5173,localhost:5173'
Remove-Item Env:BREVO_API_KEY -ErrorAction SilentlyContinue
npm run dev:server
```

In terminal 2:

```powershell
npm run dev
```

Open the Vite address on port 5173. Vite proxies `/api` and `/health` to port 3000; the explicit allowed-host entries cover the forwarded browser host. Node's watch command does not load the Compose `.env` automatically. Supply runtime variables to that terminal.

Migrations and the fixed template initialize automatically. A new development database has no agreements and automatic email is off. Do not copy working mail credentials into this environment.

The default converter URL is a Docker DNS name and is unavailable to a Node process on the host. Tracking and DOCX generation can still run; PDF conversion needs a reachable development Gotenberg endpoint with the same fonts and an explicit `NDA_CONVERTER_URL`. The main Compose deployment supplies it internally. Do not expose the production converter as an accidental public service.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite browser development server on localhost |
| `npm run dev:server` | Watch and run TypeScript HTTP backend |
| `npm test` | Unit tests, excluding PostgreSQL integration suites |
| `npm run test:integration` | PostgreSQL suites when `TEST_DATABASE_URL` is set |
| `npm run build:client` | Browser type-check and Vite production build |
| `npm run build:server` | Compile Node/shared TypeScript modules |
| `npm run build` | Both production builds |
| `npm start` | Run compiled server; requires `DATABASE_URL` |
| `npm run preview` | Static Vite preview only; not a replacement for the API/workers |
| `npm run db:import-xlsx -- --file <path>` | Specialized one-time legacy workbook migration |

The one-time migration tool expects worksheet `NDA`, exactly 11 rows and an empty record/history store. It is retained for the original migration, not a general importer. Use the website's Import Excel for normal workbooks. Warnings must be reviewed before explicitly passing `--accept-warnings`.

## Integration tests

Create a separate disposable database:

```powershell
docker run -d --name nda-test-db --tmpfs /var/lib/postgresql/data -e POSTGRES_DB=nda_tracker_test -e POSTGRES_USER=nda_test -e POSTGRES_PASSWORD=local_test_password -p 127.0.0.1:55433:5432 postgres:16-alpine
docker exec nda-test-db pg_isready -U nda_test -d nda_tracker_test
```

After it accepts connections:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://nda_test:local_test_password@127.0.0.1:55433/nda_tracker_test'
npm run test:integration
Remove-Item Env:TEST_DATABASE_URL
docker rm -f nda-test-db
```

Each suite creates and removes its own schema. The role needs permission to create schemas, functions and triggers. Tests must not target the working database. Missing `TEST_DATABASE_URL` skips these suites; a skipped suite is not a successful database test.

Email tests use mock transport. Document store tests use a local conversion stub. Tests do not send real mail or prove the visual layout of LibreOffice output. After template, font or PDF-preview changes, render real output and review every page in addition to running tests.

## Key modules

| Module | Responsibility |
| --- | --- |
| `src/core.ts` | 26-column model, date rules, exact-day reminders, validation and fingerprints |
| `src/contract-core.ts` | Contract defaults, validation, tracking mapping and template field values |
| `src/storage.ts` | HTTP repository; no local browser fallback |
| `src/importer.ts`, `src/exporter.ts` | Register workbook parsing and fixed-value export |
| `src/contracts-importer.ts` | Excel-to-contract-draft parsing |
| `src/contracts.tsx` and related components | Editor, register, next actions, signed files and job progress |
| `server/app.ts` | HTTP routes, host/origin guards, response boundaries |
| `server/store.ts` | Tracking transactions, history, notes, renewal and recovery |
| `server/contract-store.ts` | Templates, draft/version state, signed files, jobs and confirmation |
| `server/document-worker.ts` | Persistent job claiming, DOCX generation and PDF conversion |
| `server/email.ts` | Daily reservation, transport, result handling and delivery history |
| `server/backup-worker.ts` | Verified full backup creation, schedule and retention |
| `migrations/` | Incremental database schema with migration ledger |

## Contribution checks

1. Preserve the 26-column contract and distinguish contract state from tracking follow-up state.
2. Keep client records, signed files, secrets and backups outside Git. Test fixtures must be anonymized.
3. Add a new ordered migration for schema changes; do not rewrite migrations already deployed.
4. Preserve immutable document values/files and explicit conflict handling.
5. For changes that may send email, use isolated data with no provider key. A live send requires a deliberate recipient and action.
6. Run relevant unit/integration tests and the production build. Review generated document layout where applicable.
7. Update the corresponding user/API/operations documentation when behavior changes.

Stop the watch servers with Ctrl+C and remove `nda-dev-db` after development. Do not shut down unrelated Docker projects.
