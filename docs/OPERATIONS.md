# Operations and Troubleshooting

> Legacy guide: these Docker/PostgreSQL commands apply to the pre-desktop version at `f51e672`. For the current Windows SQLite application, use [Windows desktop operations](WINDOWS_DESKTOP.md). Do not rebuild an existing PostgreSQL deployment from the desktop source without first migrating and verifying its data.

This guide covers the supplied local Docker deployment. All commands run from the repository root unless another directory is specified.

## Services and access

| Service | Purpose | Host access |
| --- | --- | --- |
| `app` | UI, HTTP API, document worker, email scheduler | `http://127.0.0.1:5183` by default |
| `db` | PostgreSQL 16 | `127.0.0.1:5433`; database `nda_tracker`, user `nda_app` |
| `converter` | Gotenberg / LibreOffice | Internal Docker network only |
| `backup` | Scheduled complete database backup | No published application port |

The Compose project name is `nda-tracker`. Its database uses a named volume. Cloning this repository does not copy that volume or its data. Do not start another checkout with the same Compose project against your working deployment unless you intend to manage that same stack.

There is no user login. Keep the provided localhost bindings. Access through the API or DataGrip can change records; use read-only database sessions when inspecting data.

## Configuration

### Docker Compose `.env`

| Variable | Required | Meaning |
| --- | --- | --- |
| `NDA_DB_PASSWORD` | Yes | PostgreSQL password; the launcher generates a random value on first use |
| `NDA_PORT` | No | Published application port and allowed-host port; defaults to `5183` |
| `BREVO_API_KEY` | For email | Transactional API key, passed to the application at runtime |
| `BREVO_SENDER_EMAIL` | No | Sender fallback when no sender is saved in Settings |

Use a hexadecimal database password so that it is safe in the composed PostgreSQL connection URL. Preserve `.env` when upgrading. PostgreSQL initializes its password only when the volume is first created; editing `.env` alone does not rotate an existing database password.

The Windows launcher always opens port 5183. If `NDA_PORT` is customized, open the chosen address manually after startup.

### Server runtime variables

These are read by the Node process. The Compose file supplies most of them internally; adding an arbitrary name to `.env` does not pass it to a container unless Compose maps it.

| Variable | Default or requirement |
| --- | --- |
| `DATABASE_URL` | Required by the application; Compose constructs it for the `db` service |
| `PORT` | `3000` inside the container |
| `PUBLIC_DIR` | `dist/public` |
| `NDA_ALLOWED_HOSTS` | Optional comma-separated additional host:port entries; does not add authentication |
| `NDA_CONVERTER_URL` | `http://converter:3000` |
| `NDA_BACKUP_DIR` | Application status directory; Compose uses `/backups/automatic` read-only |

The backup container uses `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and its own `NDA_BACKUP_DIR=/backups`. These are supplied by Compose. The backup process receives a read-only PostgreSQL transaction option.

## Start, stop and upgrade

First use on Windows:

```powershell
.\OPEN-NDA-DASHBOARD.cmd
```

Health and logs:

```powershell
docker compose ps
Invoke-RestMethod http://127.0.0.1:5183/health/live
Invoke-RestMethod http://127.0.0.1:5183/health/ready
docker compose logs --tail 80 app
docker compose logs --tail 80 converter
docker compose logs --tail 80 backup
```

Liveness reports the process; readiness checks PostgreSQL. Readiness does not prove PDF conversion or mailbox delivery.

Before an upgrade:

1. Run `BACKUP-DATABASE.cmd` and retain `.env` separately.
2. Review the changes and migrations. Do not replace existing configuration with the example file.
3. Pull the intended code revision and run:

   ```powershell
   docker compose up -d --build --wait --wait-timeout 180
   ```

4. Check readiness, record counts, Contracts, settings, and backup status. Opening Preview email is read-only; sending a test is a separate explicit action.

Ordered SQL migrations run on application startup under a PostgreSQL advisory lock. Each unapplied migration is transactional and recorded in `schema_migration`. They do not reload Excel data. Old code may not understand newer deleted/signed-file states; a source-code rollback is not a database rollback.

Stop normally with `STOP-NDA-DASHBOARD.cmd` or `docker compose stop`. Do not delete volumes for a routine restart.

## Email setup and operating rules

Add the API key locally and recreate `app`, then configure a verified sender, one recipient and optional CC in Settings. Enable automatic reminders only after checking the settings and an explicit test email. A preview never sends mail.

The scheduler checks at startup and every minute. It handles the current Malaysia date only. After an outage, today's unhandled task can run once the saved time has passed; earlier dates are not replayed.

| Display state | Meaning and action |
| --- | --- |
| Paused | Automatic reminders are off |
| Waiting for backend check | Today's time has passed but no task has been created yet |
| Sending | A daily request is in progress |
| Submitted | Brevo accepted it; check provider logs or the mailbox for delivery |
| Failed | Explicit failure; inspect the reason and use Retry when appropriate |
| Needs review | Outcome cannot be established; check Brevo before any new send |
| No reminders due | No candidates; no email sent |

Formal retry is restricted to the current day while automatic reminders remain enabled and uses current settings/records. Test retry retains the test recipient. A test has example content and no CC; it does not consume the formal daily task. Changing records or settings after submission does not retract or resend that task.

If Brevo rejects an unrecognized IP address, inspect the error and update the account's authorized IPs. A Gmail sender may be displayed using a provider address; the configured sender is used as Reply-To. The app does not provide Microsoft OAuth or Outlook mailbox access: Outlook is a destination for the reminder email.

## Backup scope

| Backup | Includes | Does not include |
| --- | --- | --- |
| Register JSON / Saved versions | Active tracking records, follow-up notes in History, reminder settings | Contract drafts/files, recycle bin contents, independent mail ledger, credentials |
| Complete PostgreSQL `.dump` | All database tables, contract templates/drafts/versions/jobs, generated and signed binaries, mail ledger, recovery archives, recycle bin | `.env`, API key, application source, host fonts |

Automatic complete backups run initially and then at 02:00 MYT. The worker retains 14 successful automatic files, retries explicit failure after about 15 minutes, and does not prune manual dumps. It verifies archive contents before marking success. Files are local, so copy important backups to separate storage.

Manual backup:

```powershell
.\BACKUP-DATABASE.cmd
```

Automatic files: `backups/automatic/`. Manual files: `backups/nda-database-<timestamp>.dump`. Both directories are excluded from Git.

### Register recovery through Settings

Export the current register before recovery. Importing a valid register backup replaces the active tracking workspace, saves a pre-recovery snapshot, pauses automatic reminders and preserves independent contract files/mail records. Existing contracts reconnect by the original tracking IDs only; missing records are shown as unavailable, not recreated.

Agreements in the recycle bin must be restored before register JSON or Saved versions recovery is allowed. Contracts in the recycle bin are separate. Re-enable reminders only after checking the recovered dates, recipient and current daily mail task.

### Verify a complete backup in an isolated database

The following creates a temporary recovery-check container, not a replacement for your working database. Replace the backup path before running. The password below is only for this local disposable container.

```powershell
docker run -d --name nda-restore-check --tmpfs /var/lib/postgresql/data -e POSTGRES_DB=nda_restore_check -e POSTGRES_USER=nda_restore -e POSTGRES_PASSWORD=local_restore_check_password -p 127.0.0.1:55434:5432 postgres:16-alpine
docker exec nda-restore-check pg_isready -U nda_restore -d nda_restore_check
```

Wait until `pg_isready` reports accepting connections, then:

```powershell
docker cp "backups/your-selected-backup.dump" nda-restore-check:/tmp/restore.dump
docker exec nda-restore-check pg_restore --list /tmp/restore.dump
docker exec nda-restore-check pg_restore --exit-on-error --no-owner --no-privileges -U nda_restore -d nda_restore_check /tmp/restore.dump
docker exec nda-restore-check psql -U nda_restore -d nda_restore_check -c "SELECT count(*) AS agreements FROM nda_record; SELECT count(*) AS contracts FROM contract; SELECT count(*) AS signed_files FROM contract_signed_file;"
```

Check migration history, active/deleted record counts, history, contract-file checksums, settings and daily mail history. Do not attach a running mail scheduler to a restored copy before reviewing its saved automatic-reminder flag. Full backups retain the mail settings and deduplication ledger.

When the isolated verification is finished:

```powershell
docker rm -f nda-restore-check
```

For an actual cutover, first create a fresh current backup, stop `app` and `backup`, restore to an empty replacement database/volume, pause reminders in the restored workspace, and validate it before reconnecting the application. Retain the old database for rollback. This repository does not automate destructive in-place recovery.

## Recycle bin behavior

Delete requires confirmation and moves the item to a recoverable state. An agreement is excluded from future reminder checks; its linked contract remains. A contract is removed from the active contract list; its linked tracking agreement continues unchanged.

History and contract files remain. Already submitted emails are not recalled, and previously accepted document jobs may finish. There is no permanent-delete button. Renewal chains must be deleted from newest to oldest and restored from oldest to newest.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Docker not ready | Start Docker Desktop with Linux containers and wait for the engine |
| Port already in use | Inspect the reported port; do not stop unrelated containers. Choose another app port or resolve the conflicting deployment |
| Database password rejected after `.env` edit | Restore the prior value or perform a deliberate PostgreSQL password rotation; do not delete the volume |
| Blank website after copying files | Use the running HTTP service, not `dist/index.html` opened directly |
| Version conflict / HTTP 409 | Refresh, review newer values, and resubmit intentionally |
| No preview candidates | Exact milestones differ from display ranges; check Pending status, Malaysia date, Duration, UOM and missing dates |
| Word exists but PDF failed | Check converter health and all four Times New Roman mounts. Retry the document job; tracking still works |
| PDF catches page scrolling | Use Read PDF only when operating its controls; move the pointer outside or choose Done reading |
| Signed PDF rejected | One `.pdf`, PDF MIME type/structure, at most 20 MiB, correct contract/generated version and current draft revision |
| Backup status unavailable | Check `backup` logs and read-only status mount; a stale status is not proof a new backup completed |
| Nothing in DataGrip | Use localhost port 5433, database `nda_tracker`, user `nda_app`, and the local database password |

Never paste `.env` or a full `docker compose config` output into an issue: rendered configuration can include secrets.
