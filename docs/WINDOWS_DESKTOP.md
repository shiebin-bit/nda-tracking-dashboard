# Windows desktop edition

Each Windows user has an independent workspace. The complete x64 installer includes the application runtime, SQLite support and LibreOffice conversion files. End users do not install Docker, Node.js, PostgreSQL, MySQL or Microsoft Office.

## Install and start

1. Download `NDA-Tracker-Setup-<version>-x64.exe` from the project's GitHub Releases page, together with its SHA-256 file.
2. Run the installer and choose the installation directory. The normal per-user installation does not need an administrator account; company application-control policies can still require IT approval.
3. Open **NDA Tracker** from the desktop or Start menu. A fresh installation has no supplier, agreement or document data. The FFM NDA and EOI templates are included.
4. Add suppliers and projects, import Excel, or create a document through **New document**.

The preview installer is unsigned. Windows or company endpoint protection may show an unknown-publisher warning. Confirm the repository source and hash, and follow company IT policy. Code signing is a separate distribution step.

## Personal data and upgrades

Data lives in `%LOCALAPPDATA%\NDA Tracker`, separately from the installation directory:

| Item | Purpose |
| --- | --- |
| `nda-tracker.sqlite` | Agreements, suppliers, projects, templates, document files, History and mail ledger |
| `nda-tracker.sqlite-wal` / `-shm` | SQLite working files; do not copy/delete these while the app runs |
| `backups` | Complete automatic backups and safety copies made before restore |
| `desktop-settings.json` | Per-user desktop preferences and the Windows-protected email credential |
| `desktop.log` | Local diagnostic events, without the API key |

Use **Settings → Desktop workspace → Open data folder** to find the actual directory. Installing an update into the same application location preserves this directory. Uninstalling keeps it too. To move data between computers, use the complete-backup functions, not a copy of the live database file.

## Email and background operation

1. Obtain your own Brevo API key and verify a sender in that Brevo account.
2. In **Settings → Desktop workspace**, enter the key and optional default verified sender. Windows protects the key for the signed-in user; it is not included in any database backup or distributed installer.
3. Saving the connection restarts the local background service and pauses automatic reminders. The sender in **Reminder preferences** takes priority over the desktop default.
4. Save the intended To, optional CC list, reminder milestones and Malaysia check time. Use the explicit test button only when you want a real test email.
5. Enable automatic reminders when ready. Enable **Start with Windows** if checks should resume after signing into Windows.

Closing the window hides it to the system tray. **Quit NDA Tracker** in the tray stops all workers. Windows shutdown or sleep prevents checks; missed past dates are not replayed. On resume/startup, today's unprocessed task can run after its scheduled time. Sending email requires internet access. Local editing, document generation and backups do not.

## Complete backup and recovery

**Save complete backup** creates one verified `.sqlite` snapshot, including all generated Word/PDF files, signed copies, template versions, recycled items and mail records. It excludes the Windows-protected email key.

**Restore complete backup** verifies database identity, schema, foreign keys and file checksums; asks before replacement; saves a safety copy; restores the selected workspace; and pauses automatic reminders. The current computer's email connection remains in place. Check the recipient and Brevo logs before re-enabling reminders after a restore.

Automatic complete backups run on first start and daily at **02:00 Malaysia time**, with restart catch-up and 14 successful copies retained. A local backup does not protect against losing the whole computer; periodically save a complete copy to a separate approved drive.

The existing **NDA register JSON** export remains available. It covers the active register, History and reminder preferences only. It does not replace a complete workspace backup.

## Existing PostgreSQL users

The old Docker database is not bundled into the installer. A separate read-only import command migrates a PostgreSQL snapshot to a new SQLite file, preserves references and binary files, verifies the result, and leaves automatic reminders off. Keep a full PostgreSQL backup and the original installation until the migrated desktop workspace has been reviewed. Do not run two enabled reminder services for the same register.

Build the source, then set `NDA_IMPORT_DATABASE_URL` to your PostgreSQL connection string and `NDA_SQLITE_PATH` to a new output file. Keep the connection string private; do not paste it into issues or screenshots. Run:

```powershell
node dist/server/server/import-postgres-to-sqlite.js --help
node dist/server/server/import-postgres-to-sqlite.js
```

The source must have the legacy migrations through `010_display_references.sql`. The tool reads it in a repeatable-read, read-only transaction, verifies every imported column and binary checksum, preserves display-reference sequence positions, and refuses an existing target. Open the desktop app and use **Restore complete backup** to review this file in a local workspace. The importer does not start either reminder service or copy the email credential.

Validation on 19 November used an isolated PostgreSQL source with synthetic NDA/EOI documents and signed files. The working Docker database was offline and was not migrated or changed.

## Build the installer from source

Build on Windows x64 with Node.js 24 and a complete LibreOffice installation available to the build machine:

```powershell
npm ci
node node_modules/electron/install.js
npm test
npm run test:integration
npm run desktop:prepare
npm run desktop:dist
```

`desktop:prepare` copies the complete installed LibreOffice distribution from `C:\Program Files\LibreOffice` (override with `NDA_LIBREOFFICE_DIR`) into ignored staging files. It downloads the official Microsoft VCLibs x64 runtime for app-local conversion dependencies, preserving component notices and a source manifest. It does not bundle Windows fonts.

Outputs are in the ignored `release` directory. Inspect the packaged application and installer for credentials, user databases, backups and build-machine paths before publication. The build does not publish a GitHub Release automatically. No signing certificate or Brevo API key belongs in the installer.

For local development, `npm run desktop:dev` opens the desktop app. `NDA_DESKTOP_DATA_DIR` can select an isolated test directory. Development and packaged tests must use disposable directories and synthetic email transport rather than the working register.
