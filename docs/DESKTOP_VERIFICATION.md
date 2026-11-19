# Windows desktop preview verification

Build: `0.2.0-beta.1`, Windows x64, 19 November 2026.

## Verified

- 135 unit tests and 49 SQLite integration tests pass; no application integration suite is skipped. Legacy PostgreSQL engine migration tests have been replaced with SQLite lifecycle coverage.
- Client and server production builds pass. Electron 45.3.4 contains Node 24.22.3 and the built-in SQLite implementation.
- Fresh workspaces have no working records, recipients, email key or enabled reminders. Two default template families are supplied.
- The packaged application generates real NDA and EOI Word/PDF files using its bundled LibreOffice distribution. Signed-file upload and repeat confirmation create exactly one NDA register entry; EOI creates none.
- Complete online backup and restore preserve document files. Restore pauses reminders and keeps the desktop credential separate. Unknown schema objects, invalid database identity and altered template bytes are rejected.
- Closing the main window leaves the local backend available through the tray; unauthenticated requests outside the desktop session receive 403.
- Generation also succeeds with the desktop child's PATH restricted to Windows System32. Windows startup registration/removal, unsaved-form protection and Windows-encrypted credential save/removal were exercised. Reminder settings stay paused after a connection change.
- Excel export downloads a workbook that reopens with the original 26 columns and the expected record count. Word/PDF download links and the same-origin PDF popup work inside Electron.
- The packaged application directory was scanned: 9,916 files (about 89 MB), including checks against the configured developer database password and Brevo key. Neither secret, any working database nor any database backup was found.
- A separate, disposable PostgreSQL 18 source was initialized with legacy migrations and synthetic suppliers, NDA/EOI documents, generated artifacts, signed copies and email ledger rows. Read-only import checks every imported column, binary digest and foreign key, preserves reference sequence gaps and CC lists, and pauses reminders only in the destination. An existing output file is refused.
- `npm audit --omit=dev` reports zero production advisories. Six moderate advisories remain in build tooling.

## Boundaries

The working Docker engine was offline during final validation. No production database was migrated, changed or included in the installer. No real email was sent. Email state-machine tests use synthetic transport; they are not a delivery receipt.

The initial independent architecture review informed the implementation. A second independent review was unavailable; it is not claimed as completed. Verification above is based on automated checks and local execution.

This preview is unsigned. It has not been tested on a clean Windows virtual machine or under the recipient company's application-control policy. Local LibreOffice output was rendered and inspected, including inherited page breaks; final contract pagination should still be reviewed before sending a document for signature. Physical printer output is not verified. Support targets Windows x64 with Windows Times New Roman available.

Installer/reinstall checks and artifact hashes are recorded with the final build below once completed.
