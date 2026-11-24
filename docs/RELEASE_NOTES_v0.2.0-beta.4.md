# NDA Tracker v0.2.0-beta.4

Windows x64 preview · 24 November 2026

## Documents

- Search supplier and project selections by ID or name, with keyboard navigation and prefix matches first.
- Choose a published template version in New document and in the document editor. The selection applies to the next generation in that open editor; reopening or bulk generation uses the current published version.
- Configure download filename parts and their order in Settings. Word, PDF and batch ZIP entries use generation-time supplier/project/date details, with a mandatory document reference and version suffix. Signed copies retain their uploaded filenames.

## Templates

- View and download earlier published versions, or explicitly copy one into the working draft without deleting published history.
- Select text and bind a field in one operation, replace repeated text, inspect field locations and undo recent edits.
- Import existing brace placeholders and exact bracketed EOI supplier/project labels. Ordinary names still require explicit field mapping.
- Keep run formatting during Word text edits and apply bold to field values. The packaged EOI 1.1 uses bold supplier/project values; existing custom templates and unpublished drafts are preserved.
- Insert/delete eligible Word body paragraphs and simple table rows. New content inherits source formatting. Deletion confirms affected fields and removes definitions whose final occurrence is deleted; Undo restores the edit.
- Keep merged/nested tables, protected Word structures, section boundaries and header/footer structures protected. This remains a controlled template editor; use Word for unsupported layout changes and import a separate template when needed.
- Fix empty legacy NDA field schemas when creating a working draft from an earlier published version.

## Data and installation

The installer bundles Electron, SQLite support, LibreOffice conversion and its app-local runtime. Docker, Node.js, a database server and Microsoft Office are not required on users' computers.

New Windows users start with an empty personal workspace and packaged NDA/EOI templates. Runtime records, private uploaded templates, generated/signed files and Brevo credentials are excluded from this release. Each user's data is independent.

Save a complete workspace backup before updating. SQLite workspace version 2 adds document naming preferences and validates/upgrades supported older complete backups through a disposable staging copy. Existing records, document files, template history and saved reminder settings are retained by an ordinary update. Register-only JSON remains limited to the NDA register.

Download the installer and matching `.sha256` file. Verify the checksum, run setup and follow [INSTALL.md](https://github.com/shiebin-bit/nda-tracking-dashboard/blob/v0.2.0-beta.4/docs/INSTALL.md). This is an unsigned preview; clean Windows VM and company application-control testing remain outstanding.

## Reminder behavior

No change to reminder milestones or daily scheduling. Email requires your configured Brevo credentials and verified sender, network access, and a running application on an awake computer. This release does not resolve Brevo's unrecognized-IP restriction. Verification does not send additional real emails.

## Verification

179 unit tests, 66 disposable SQLite integration tests and the client/server production build pass. Browser checks cover paragraph/row insertion, edited-content deletion, field cleanup, coalesced typing Undo, preview, publication, copying a baked version and a 390px layout. Actual local-converter PDF output was inspected for the structural fixture and existing NDA/EOI templates. Independent focused review found no remaining release blockers after legacy paragraph-ID and protected-range fixes.

Review every generated contract page before publishing a template or sending a document for signature. One-page layout of a personal EOI template is local workspace content and is not copied into other users' installations. Physical printing and a clean Windows VM are not verified.
